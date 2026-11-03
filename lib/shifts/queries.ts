/**
 * Read-side queries for shifts. Every amount shown in the UI is produced by the
 * tip engine from database rows here — never by the browser and never by the AI.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/connect";
import * as s from "../db/schema";
import { allocateTips, type AllocationResult, type EngineAssignment } from "../tips/engine";
import { detectFlags, type ShiftFlag } from "../tips/flags";
import { policyForDate } from "../tips/policy";

export type ShiftListRow = {
  id: string;
  date: string;
  service: string;
  status: "open" | "closed" | "paid";
  grossPence: number;
  isDemoPool: boolean;
  staffCount: number;
  uncoveredCount: number;
  batchStatus: string | null;
};

export async function listShifts(db: Db): Promise<ShiftListRow[]> {
  const shifts = await db.select().from(s.shifts).orderBy(desc(s.shifts.date));
  if (!shifts.length) return [];
  const ids = shifts.map((x) => x.id);
  const [pools, assignments, batches] = await Promise.all([
    db.select().from(s.tipPools).where(inArray(s.tipPools.shiftId, ids)),
    db.select().from(s.shiftAssignments).where(inArray(s.shiftAssignments.shiftId, ids)),
    db
      .select()
      .from(s.payoutBatches)
      .where(and(inArray(s.payoutBatches.shiftId, ids), eq(s.payoutBatches.kind, "shift"))),
  ]);
  return shifts.map((sh) => {
    const pool = pools.find((p) => p.shiftId === sh.id);
    const as = assignments.filter((a) => a.shiftId === sh.id);
    return {
      id: sh.id,
      date: sh.date,
      service: sh.service,
      status: sh.status,
      grossPence: pool?.grossPence ?? 0,
      isDemoPool: pool?.isDemo ?? false,
      staffCount: as.filter((a) => a.workerId).length,
      uncoveredCount: as.filter((a) => a.status === "uncovered").length,
      batchStatus: batches.find((b) => b.shiftId === sh.id)?.status ?? null,
    };
  });
}

export type ReviewAssignment = typeof s.shiftAssignments.$inferSelect & {
  workerName: string | null;
  corrections: (typeof s.timeCorrections.$inferSelect)[];
};

export type ShiftReview = {
  shift: typeof s.shifts.$inferSelect;
  pool: typeof s.tipPools.$inferSelect | null;
  policy: typeof s.tipPolicies.$inferSelect | null;
  assignments: ReviewAssignment[];
  flags: ShiftFlag[];
  /** Fresh engine run on current data (preview). */
  preview: AllocationResult | null;
  /** Allocations locked by "Save allocation" (empty while the shift is open). */
  saved: Array<typeof s.allocations.$inferSelect & { workerName: string }>;
  batch: typeof s.payoutBatches.$inferSelect | null;
  payouts: Array<typeof s.payouts.$inferSelect & { workerName: string }>;
};

export function toEngineAssignments(rows: ReviewAssignment[]): EngineAssignment[] {
  return rows.map((a) => ({
    assignmentId: a.id,
    workerId: a.workerId,
    workerName: a.workerName ?? undefined,
    role: a.role,
    status: a.status,
    clockIn: a.clockIn,
    clockOut: a.clockOut,
    breakMinutes: a.breakMinutes,
  }));
}

export async function getShiftReview(db: Db, shiftId: string): Promise<ShiftReview | null> {
  const [shift] = await db.select().from(s.shifts).where(eq(s.shifts.id, shiftId));
  if (!shift) return null;

  const [[pool], policies, rows, workers] = await Promise.all([
    db.select().from(s.tipPools).where(eq(s.tipPools.shiftId, shiftId)),
    db.select().from(s.tipPolicies).where(eq(s.tipPolicies.venueId, shift.venueId)),
    db.select().from(s.shiftAssignments).where(eq(s.shiftAssignments.shiftId, shiftId)).orderBy(asc(s.shiftAssignments.scheduledStart), asc(s.shiftAssignments.id)),
    db.select({ id: s.workers.id, name: s.workers.name }).from(s.workers).where(eq(s.workers.venueId, shift.venueId)),
  ]);
  const nameOf = (id: string | null) => workers.find((w) => w.id === id)?.name ?? null;

  const corrections = rows.length
    ? await db
        .select()
        .from(s.timeCorrections)
        .where(inArray(s.timeCorrections.shiftAssignmentId, rows.map((r) => r.id)))
        .orderBy(asc(s.timeCorrections.createdAt))
    : [];

  const assignments: ReviewAssignment[] = rows.map((r) => ({
    ...r,
    workerName: nameOf(r.workerId),
    corrections: corrections.filter((c) => c.shiftAssignmentId === r.id),
  }));

  const policy = policyForDate(policies, shift.date);
  const preview =
    pool && policy
      ? allocateTips({
          grossPence: pool.grossPence,
          policy: { id: policy.id, version: policy.version, rules: policy.rules },
          assignments: toEngineAssignments(assignments),
        })
      : null;

  const flags = detectFlags(
    assignments.map((a) => ({
      assignmentId: a.id,
      workerId: a.workerId,
      workerName: a.workerName ?? undefined,
      status: a.status,
      scheduledStart: a.scheduledStart,
      scheduledEnd: a.scheduledEnd,
      clockIn: a.clockIn,
      clockOut: a.clockOut,
      breakMinutes: a.breakMinutes,
    })),
  );

  const saved = pool
    ? (await db.select().from(s.allocations).where(eq(s.allocations.tipPoolId, pool.id))).map((a) => ({
        ...a,
        workerName: nameOf(a.workerId) ?? a.workerId,
      }))
    : [];

  const [batch] = await db
    .select()
    .from(s.payoutBatches)
    .where(and(eq(s.payoutBatches.shiftId, shiftId), eq(s.payoutBatches.kind, "shift")));
  const payouts = batch
    ? (await db.select().from(s.payouts).where(eq(s.payouts.batchId, batch.id))).map((p) => ({
        ...p,
        workerName: nameOf(p.workerId) ?? p.workerId,
      }))
    : [];

  return { shift, pool: pool ?? null, policy, assignments, flags, preview, saved, batch: batch ?? null, payouts };
}

export async function getDashboardSummary(db: Db) {
  const [shifts, payouts, policies] = await Promise.all([
    listShifts(db),
    db
      .select({
        id: s.payouts.id,
        amountPence: s.payouts.amountPence,
        status: s.payouts.status,
        reconciliationIssue: s.payouts.reconciliationIssue,
        updatedAt: s.payouts.updatedAt,
        workerName: s.workers.name,
        shiftId: s.payoutBatches.shiftId,
      })
      .from(s.payouts)
      .innerJoin(s.workers, eq(s.workers.id, s.payouts.workerId))
      .innerJoin(s.payoutBatches, eq(s.payoutBatches.id, s.payouts.batchId))
      .orderBy(desc(s.payouts.updatedAt))
      .limit(8),
    db.select().from(s.tipPolicies).orderBy(desc(s.tipPolicies.version)),
  ]);
  return {
    shifts,
    recentPayouts: payouts,
    currentPolicy: policies[0] ?? null,
    counts: {
      openShifts: shifts.filter((x) => x.status === "open").length,
      awaitingPayout: shifts.filter((x) => x.status === "closed" && !x.batchStatus).length,
      uncoveredSlots: shifts.reduce((n, x) => n + x.uncoveredCount, 0),
      // Only items PayPal reports as SUCCESS *and* that reconcile exactly.
      paidPence: payouts.filter((p) => p.status === "success" && !p.reconciliationIssue).reduce((n, p) => n + p.amountPence, 0),
    },
  };
}

export async function listPolicies(db: Db) {
  return db.select().from(s.tipPolicies).orderBy(desc(s.tipPolicies.version));
}

export async function listWorkers(db: Db) {
  return db.select().from(s.workers).orderBy(asc(s.workers.name));
}
