/**
 * Write-side shift commands. All run in a transaction that locks the shift row
 * (SELECT … FOR UPDATE), so concurrent requests are serialised.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/connect";
import * as s from "../db/schema";
import { allocateTips } from "../tips/engine";
import { policyForDate } from "../tips/policy";
import { toEngineAssignments } from "./queries";

export class ShiftCommandError extends Error {
  name = "ShiftCommandError";
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function lockShift(tx: Tx, shiftId: string) {
  const [shift] = await tx.select().from(s.shifts).where(eq(s.shifts.id, shiftId)).for("update");
  if (!shift) throw new ShiftCommandError("Shift not found");
  return shift;
}

async function shiftBatch(tx: Tx, shiftId: string) {
  const [batch] = await tx
    .select()
    .from(s.payoutBatches)
    .where(and(eq(s.payoutBatches.shiftId, shiftId), eq(s.payoutBatches.kind, "shift")));
  return batch;
}

export type CorrectionInput = {
  assignmentId: string;
  field: "clock_in" | "clock_out" | "break_minutes";
  /** ISO timestamp for clock fields, integer minutes for break */
  value: string;
  reason: string;
  actor: string;
};

/**
 * Correct a worker's recorded hours. Never silently overwrites evidence:
 * - appends a row to time_corrections (original value, new value, actor, reason, time)
 * - on the first correction, freezes original_clock_in/out on the assignment
 * - if allocations were saved, they are discarded and the shift reopens
 * Refused once a payout batch exists for the shift.
 */
export async function correctAssignmentTime(db: Db, input: CorrectionInput) {
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ShiftCommandError("Please give a reason (at least 5 characters)");
  if (reason.length > 500) throw new ShiftCommandError("Reason is too long");

  let newValue: string;
  let patch: Partial<typeof s.shiftAssignments.$inferInsert>;
  if (input.field === "break_minutes") {
    const n = Number(input.value);
    if (!Number.isSafeInteger(n) || n < 0 || n > 600) throw new ShiftCommandError("Break must be 0–600 whole minutes");
    newValue = String(n);
    patch = { breakMinutes: n };
  } else {
    const d = new Date(input.value);
    if (Number.isNaN(d.getTime())) throw new ShiftCommandError("Invalid time");
    newValue = d.toISOString();
    patch = input.field === "clock_in" ? { clockIn: d } : { clockOut: d };
  }

  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(s.shiftAssignments).where(eq(s.shiftAssignments.id, input.assignmentId));
    if (!a) throw new ShiftCommandError("Shift assignment not found");
    if (!a.workerId) throw new ShiftCommandError("Cannot record hours for an uncovered slot");
    const shift = await lockShift(tx, a.shiftId);
    if (await shiftBatch(tx, shift.id)) {
      throw new ShiftCommandError("A payout has already been requested for this shift; hours are locked. Use a pay query instead.");
    }

    const original =
      input.field === "break_minutes"
        ? String(a.breakMinutes)
        : (input.field === "clock_in" ? a.clockIn : a.clockOut)?.toISOString() ?? null;
    if (original === newValue) throw new ShiftCommandError("The new value is the same as the current value");

    // Window sanity: corrected times must sit within 24h of the scheduled shift.
    if (input.field !== "break_minutes") {
      const d = new Date(newValue).getTime();
      const lo = a.scheduledStart.getTime() - 12 * 3600_000;
      const hi = a.scheduledEnd.getTime() + 12 * 3600_000;
      if (d < lo || d > hi) throw new ShiftCommandError("That time is more than 12 hours from the scheduled shift");
    }

    await tx.insert(s.timeCorrections).values({
      shiftAssignmentId: a.id,
      field: input.field,
      originalValue: original,
      newValue,
      actor: input.actor,
      reason,
    });

    const evidence = a.hoursCorrected
      ? {}
      : { hoursCorrected: true, originalClockIn: a.clockIn, originalClockOut: a.clockOut };
    const next = { ...a, ...patch };
    const status = next.clockIn && next.clockOut && a.status === "scheduled" ? ("worked" as const) : a.status;
    await tx.update(s.shiftAssignments).set({ ...patch, ...evidence, status }).where(eq(s.shiftAssignments.id, a.id));

    // Any saved allocation is now stale: discard it and reopen the shift.
    if (shift.status === "closed") {
      const [pool] = await tx.select().from(s.tipPools).where(eq(s.tipPools.shiftId, shift.id));
      if (pool) await tx.delete(s.allocations).where(eq(s.allocations.tipPoolId, pool.id));
      await tx.update(s.shifts).set({ status: "open" }).where(eq(s.shifts.id, shift.id));
    }

    await tx.insert(s.auditLog).values({
      actor: input.actor,
      action: "hours.corrected",
      entity: "shift_assignment",
      entityId: a.id,
      data: { field: input.field, original, newValue, reason, reopenedShift: shift.status === "closed" },
    });
    return { original, newValue };
  });
}

/**
 * Lock in the allocation: recalculates on the server from current DB rows (never
 * trusts amounts from the browser), stores one allocation per worker with its
 * full trace and policy reference, and moves the shift to "closed".
 */
export async function saveAllocation(db: Db, shiftId: string, actor: string) {
  return db.transaction(async (tx) => {
    const shift = await lockShift(tx, shiftId);
    if (shift.status !== "open") throw new ShiftCommandError(`Shift is already ${shift.status}`);
    if (await shiftBatch(tx, shiftId)) throw new ShiftCommandError("A payout already exists for this shift");

    const [pool] = await tx.select().from(s.tipPools).where(eq(s.tipPools.shiftId, shiftId));
    if (!pool) throw new ShiftCommandError("This shift has no tip pool");
    const policies = await tx.select().from(s.tipPolicies).where(eq(s.tipPolicies.venueId, shift.venueId));
    const policy = policyForDate(policies, shift.date);
    if (!policy) throw new ShiftCommandError(`No tipping policy was in force on ${shift.date}`);

    const rows = await tx.select().from(s.shiftAssignments).where(eq(s.shiftAssignments.shiftId, shiftId));
    const result = allocateTips({
      grossPence: pool.grossPence,
      policy: { id: policy.id, version: policy.version, rules: policy.rules },
      assignments: toEngineAssignments(rows.map((r) => ({ ...r, workerName: null, corrections: [] }))),
    });
    if (!result.ok) {
      throw new ShiftCommandError(`Cannot save: ${result.blockers.map((b) => b.message).join("; ")}`);
    }

    await tx.delete(s.allocations).where(eq(s.allocations.tipPoolId, pool.id));
    if (result.workers.length) {
      await tx.insert(s.allocations).values(
        result.workers.map((w) => ({
          tipPoolId: pool.id,
          workerId: w.workerId,
          policyId: policy.id,
          workedMinutes: w.workedMinutes,
          weightBp: w.weightBp,
          points: w.points,
          sharePence: w.sharePence,
          explanationJson: {
            ...w,
            grossPence: result.grossPence,
            totalPoints: result.totalPoints,
            policy: { id: policy.id, version: policy.version, effectiveFrom: policy.effectiveFrom },
            calculatedAt: new Date().toISOString(),
          },
        })),
      );
    }
    await tx.update(s.shifts).set({ status: "closed" }).where(eq(s.shifts.id, shiftId));
    await tx.insert(s.auditLog).values({
      actor,
      action: "allocation.saved",
      entity: "shift",
      entityId: shiftId,
      data: { policyVersion: policy.version, grossPence: result.grossPence, allocatedPence: result.allocatedPence },
    });
    return result;
  });
}

/** Unlock a saved allocation (only while no payout exists). */
export async function reopenShift(db: Db, shiftId: string, actor: string) {
  return db.transaction(async (tx) => {
    const shift = await lockShift(tx, shiftId);
    if (shift.status !== "closed") throw new ShiftCommandError("Only a saved (closed) shift can be reopened");
    if (await shiftBatch(tx, shiftId)) throw new ShiftCommandError("A payout already exists for this shift");
    const [pool] = await tx.select().from(s.tipPools).where(eq(s.tipPools.shiftId, shiftId));
    if (pool) await tx.delete(s.allocations).where(eq(s.allocations.tipPoolId, pool.id));
    await tx.update(s.shifts).set({ status: "open" }).where(eq(s.shifts.id, shiftId));
    await tx.insert(s.auditLog).values({ actor, action: "allocation.reopened", entity: "shift", entityId: shiftId });
  });
}
