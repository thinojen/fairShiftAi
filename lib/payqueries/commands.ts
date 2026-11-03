/**
 * Pay queries: a worker disputes a recorded value (e.g. clock-out time).
 *
 *   draft → submitted → accepted → resolved
 *   submitted → rejected
 *
 * Nothing here changes hours, allocations or payments. A query is a CLAIM with
 * evidence; the manager fixes records through the existing audited correction
 * and approval flows.
 *
 * Proposals are pure reads (used by the AI). Drafts are only created by an
 * explicit worker action, and submitted by a second explicit worker action.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/connect";
import * as s from "../db/schema";
import { formatDateTime, formatMinutes } from "../format";
import { allocateTips } from "../tips/engine";
import { policyForDate } from "../tips/policy";

export class PayQueryError extends Error {
  name = "PayQueryError";
  constructor(
    message: string,
    readonly code: "not_found" | "invalid" | "duplicate" | "transition",
  ) {
    super(message);
  }
}

export type PayQueryField = "clock_in" | "clock_out" | "break_minutes";

export type ProposalInput = {
  shiftAssignmentId: string;
  field: PayQueryField;
  /** For clock fields: minutes to add to the recorded time (e.g. +60 for "an extra hour"). */
  adjustMinutes?: number | null;
  /** For clock fields: an exact London wall-clock time "HH:MM" instead of an adjustment. */
  claimedTime?: string | null;
  /** For clock fields: an exact ISO timestamp (from a proposal card). Re-validated like any claim. */
  claimedIso?: string | null;
  /** For break_minutes: the claimed break length. */
  claimedBreakMinutes?: number | null;
  workerStatement: string;
  aiSummary?: string | null;
};

export type PayQueryEvidence = {
  shift: { id: string; date: string; service: string };
  role: string;
  rota: { start: string; end: string };
  recorded: { clockIn: string | null; clockOut: string | null; breakMinutes: number };
  original: { clockIn: string | null; clockOut: string | null; hoursCorrected: boolean };
  corrections: Array<{ field: string; from: string | null; to: string; by: string; at: string; reason: string }>;
  allocation:
    | { state: "locked"; allocationId: string; sharePence: number; workedMinutes: number; policyVersion: number }
    | { state: "provisional"; sharePence: number; workedMinutes: number; policyVersion: number }
    | { state: "blocked"; reasons: string[] }
    | { state: "none" };
  payout: { status: string; paypalBatchId: string | null; paypalItemId: string | null } | null;
};

export type PayQueryProposal = {
  shiftAssignmentId: string;
  field: PayQueryField;
  recordedValue: string | null;
  claimedValue: string;
  recordedLabel: string;
  claimedLabel: string;
  differenceLabel: string | null;
  workerStatement: string;
  aiSummary: string | null;
  evidence: PayQueryEvidence;
};

const LONDON = "Europe/London";

function londonDateOf(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** "HH:MM" on the same night as `anchor` (rolls past midnight if earlier than `anchor`'s start). */
function claimedClockTime(hhmm: string, anchor: Date, notBefore: Date): Date {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) throw new PayQueryError("Claimed time must be HH:MM (24-hour)", "invalid");
  const day = londonDateOf(anchor);
  // Build the London wall-clock time; try BST then GMT offsets.
  const [y, mo, d] = day.split("-").map(Number);
  const base = Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2]));
  const fmt = (t: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
  let candidate: Date | null = null;
  for (const off of [1, 0]) {
    const c = new Date(base - off * 3600_000);
    if (fmt(c) === hhmm) {
      candidate = c;
      break;
    }
  }
  if (!candidate) throw new PayQueryError("That time doesn't exist on that date (clock change)", "invalid");
  if (candidate.getTime() <= notBefore.getTime()) candidate = new Date(candidate.getTime() + 24 * 3600_000);
  return candidate;
}

async function loadAssignmentForWorker(db: Db, workerId: string, shiftAssignmentId: string) {
  const [a] = await db
    .select()
    .from(s.shiftAssignments)
    .where(and(eq(s.shiftAssignments.id, shiftAssignmentId), eq(s.shiftAssignments.workerId, workerId)));
  // Same answer whether the record doesn't exist or belongs to someone else.
  if (!a) throw new PayQueryError("No shift record found for you with that id", "not_found");
  return a;
}

export async function buildEvidence(db: Db, workerId: string, shiftAssignmentId: string): Promise<{ evidence: PayQueryEvidence; allocationId: string | null }> {
  const a = await loadAssignmentForWorker(db, workerId, shiftAssignmentId);
  const [shift] = await db.select().from(s.shifts).where(eq(s.shifts.id, a.shiftId));
  const [pool] = await db.select().from(s.tipPools).where(eq(s.tipPools.shiftId, shift.id));
  const corrections = await db
    .select()
    .from(s.timeCorrections)
    .where(eq(s.timeCorrections.shiftAssignmentId, a.id))
    .orderBy(asc(s.timeCorrections.createdAt));

  let allocation: PayQueryEvidence["allocation"] = { state: "none" };
  let allocationId: string | null = null;
  if (pool) {
    const [saved] = await db
      .select()
      .from(s.allocations)
      .where(and(eq(s.allocations.tipPoolId, pool.id), eq(s.allocations.workerId, workerId)));
    const policies = await db.select().from(s.tipPolicies).where(eq(s.tipPolicies.venueId, shift.venueId));
    const policy = policyForDate(policies, shift.date);
    if (saved) {
      allocationId = saved.id;
      allocation = {
        state: "locked",
        allocationId: saved.id,
        sharePence: saved.sharePence,
        workedMinutes: saved.workedMinutes,
        policyVersion: policies.find((p) => p.id === saved.policyId)?.version ?? 0,
      };
    } else if (policy) {
      const rows = await db.select().from(s.shiftAssignments).where(eq(s.shiftAssignments.shiftId, shift.id));
      const r = allocateTips({
        grossPence: pool.grossPence,
        policy: { id: policy.id, version: policy.version, rules: policy.rules },
        assignments: rows.map((x) => ({ assignmentId: x.id, workerId: x.workerId, role: x.role, status: x.status, clockIn: x.clockIn, clockOut: x.clockOut, breakMinutes: x.breakMinutes })),
      });
      if (r.ok) {
        const mine = r.workers.find((w) => w.workerId === workerId);
        if (mine) allocation = { state: "provisional", sharePence: mine.sharePence, workedMinutes: mine.workedMinutes, policyVersion: policy.version };
      } else {
        allocation = { state: "blocked", reasons: r.blockers.map((b) => b.code) };
      }
    }
  }

  let payout: PayQueryEvidence["payout"] = null;
  const [batch] = await db
    .select()
    .from(s.payoutBatches)
    .where(and(eq(s.payoutBatches.shiftId, shift.id), eq(s.payoutBatches.kind, "shift")));
  if (batch) {
    const [p] = await db.select().from(s.payouts).where(and(eq(s.payouts.batchId, batch.id), eq(s.payouts.workerId, workerId)));
    if (p) payout = { status: p.reconciliationIssue ? "needs_review" : p.status, paypalBatchId: batch.paypalBatchId, paypalItemId: p.paypalItemId };
  }

  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    allocationId,
    evidence: {
      shift: { id: shift.id, date: shift.date, service: shift.service },
      role: a.role,
      rota: { start: a.scheduledStart.toISOString(), end: a.scheduledEnd.toISOString() },
      recorded: { clockIn: iso(a.clockIn), clockOut: iso(a.clockOut), breakMinutes: a.breakMinutes },
      original: a.hoursCorrected
        ? { clockIn: iso(a.originalClockIn), clockOut: iso(a.originalClockOut), hoursCorrected: true }
        : { clockIn: iso(a.clockIn), clockOut: iso(a.clockOut), hoursCorrected: false },
      corrections: corrections.map((c) => ({ field: c.field, from: c.originalValue, to: c.newValue, by: c.actor, at: c.createdAt.toISOString(), reason: c.reason })),
      allocation,
      payout,
    },
  };
}

async function openQueryFor(db: Db, workerId: string, shiftAssignmentId: string) {
  const [q] = await db
    .select({ id: s.payQueries.id, status: s.payQueries.status })
    .from(s.payQueries)
    .where(
      and(
        eq(s.payQueries.workerId, workerId),
        eq(s.payQueries.shiftAssignmentId, shiftAssignmentId),
        inArray(s.payQueries.status, [...s.OPEN_PAY_QUERY_STATUSES]),
      ),
    );
  return q ?? null;
}

function cleanText(v: string | null | undefined, max: number) {
  return (v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
}

/** Build (but do not save) a pay query. Safe for the AI to call: it writes nothing. */
export async function proposePayQuery(db: Db, workerId: string, input: ProposalInput): Promise<PayQueryProposal> {
  const statement = cleanText(input.workerStatement, 500);
  if (statement.length < 3) throw new PayQueryError("Please describe what you think is wrong", "invalid");

  const a = await loadAssignmentForWorker(db, workerId, input.shiftAssignmentId);
  if (a.status === "uncovered") throw new PayQueryError("That slot has no worker", "invalid");
  const existing = await openQueryFor(db, workerId, a.id);
  if (existing) throw new PayQueryError(`You already have an open query (${existing.status}) for this shift`, "duplicate");

  let recordedValue: string | null;
  let claimedValue: string;
  let recordedLabel: string;
  let claimedLabel: string;
  let differenceLabel: string | null = null;

  if (input.field === "break_minutes") {
    const claimed = input.claimedBreakMinutes;
    if (claimed == null || !Number.isSafeInteger(claimed) || claimed < 0 || claimed > 600) {
      throw new PayQueryError("Claimed break must be 0–600 whole minutes", "invalid");
    }
    if (claimed === a.breakMinutes) throw new PayQueryError("That matches the recorded break", "invalid");
    recordedValue = String(a.breakMinutes);
    claimedValue = String(claimed);
    recordedLabel = `${a.breakMinutes} min break`;
    claimedLabel = `${claimed} min break`;
    const diff = claimed - a.breakMinutes;
    differenceLabel = `${diff > 0 ? "+" : "−"}${formatMinutes(Math.abs(diff))} break`;
  } else {
    const recorded = input.field === "clock_in" ? a.clockIn : a.clockOut;
    const fallback = input.field === "clock_in" ? a.scheduledStart : a.scheduledEnd;
    let claimed: Date;
    if (input.adjustMinutes != null) {
      if (!Number.isSafeInteger(input.adjustMinutes) || input.adjustMinutes === 0 || Math.abs(input.adjustMinutes) > 360) {
        throw new PayQueryError("Adjustment must be a non-zero whole number of minutes, up to 6 hours", "invalid");
      }
      if (!recorded) throw new PayQueryError("There's no recorded time to adjust — give the exact time instead", "invalid");
      claimed = new Date(recorded.getTime() + input.adjustMinutes * 60_000);
    } else if (input.claimedIso) {
      claimed = new Date(input.claimedIso);
      if (Number.isNaN(claimed.getTime())) throw new PayQueryError("Invalid claimed time", "invalid");
    } else if (input.claimedTime) {
      claimed = claimedClockTime(input.claimedTime, a.scheduledStart, input.field === "clock_out" ? (a.clockIn ?? a.scheduledStart) : new Date(a.scheduledStart.getTime() - 12 * 3600_000));
    } else {
      throw new PayQueryError("Say what the correct time is, or how many minutes it is out by", "invalid");
    }
    const lo = a.scheduledStart.getTime() - 12 * 3600_000;
    const hi = a.scheduledEnd.getTime() + 12 * 3600_000;
    if (claimed.getTime() < lo || claimed.getTime() > hi) throw new PayQueryError("That time is too far from the scheduled shift", "invalid");
    if (recorded && claimed.getTime() === recorded.getTime()) throw new PayQueryError("That matches the recorded time", "invalid");

    recordedValue = recorded ? recorded.toISOString() : null;
    claimedValue = claimed.toISOString();
    const label = input.field === "clock_in" ? "clock-in" : "clock-out";
    recordedLabel = recorded ? `${label} ${formatDateTime(recorded)}` : `${label} missing (rota ${formatDateTime(fallback)})`;
    claimedLabel = `${label} ${formatDateTime(claimed)}`;
    if (recorded) {
      const diff = Math.round((claimed.getTime() - recorded.getTime()) / 60_000);
      differenceLabel = `${diff > 0 ? "+" : "−"}${formatMinutes(Math.abs(diff))}`;
    }
  }

  const { evidence } = await buildEvidence(db, workerId, a.id);
  return {
    shiftAssignmentId: a.id,
    field: input.field,
    recordedValue,
    claimedValue,
    recordedLabel,
    claimedLabel,
    differenceLabel,
    workerStatement: statement,
    aiSummary: input.aiSummary ? cleanText(input.aiSummary, 1000) : null,
    evidence,
  };
}

/**
 * Worker clicked "Create draft". Everything is recomputed server-side from the
 * submitted intent — the client can't inject evidence or values.
 */
export async function createPayQueryDraft(db: Db, workerId: string, input: ProposalInput) {
  const proposal = await proposePayQuery(db, workerId, input);
  const { allocationId } = await buildEvidence(db, workerId, proposal.shiftAssignmentId);
  try {
    return await db.transaction(async (tx) => {
      const [q] = await tx
        .insert(s.payQueries)
        .values({
          workerId,
          shiftAssignmentId: proposal.shiftAssignmentId,
          allocationId,
          field: proposal.field,
          recordedValue: proposal.recordedValue,
          claimedValue: proposal.claimedValue,
          workerMessage: proposal.workerStatement,
          aiSummary: proposal.aiSummary,
          evidenceJson: proposal.evidence,
          status: "draft",
        })
        .returning();
      await tx.insert(s.auditLog).values({
        actor: `worker:${workerId}`,
        action: "pay_query.draft_created",
        entity: "pay_query",
        entityId: q.id,
        data: { shiftAssignmentId: q.shiftAssignmentId, field: q.field, recordedValue: q.recordedValue, claimedValue: q.claimedValue },
      });
      return q;
    });
  } catch (e) {
    if (e instanceof Error && /pay_queries_one_open_per_shift|duplicate key|unique/i.test(e.message + String((e as { cause?: unknown }).cause ?? ""))) {
      throw new PayQueryError("You already have an open query for this shift", "duplicate");
    }
    throw e;
  }
}

type Transition = { from: (typeof s.payQueryStatusEnum.enumValues)[number]; to: (typeof s.payQueryStatusEnum.enumValues)[number]; by: "worker" | "manager"; noteRequired: boolean };
export const TRANSITIONS: Transition[] = [
  { from: "draft", to: "submitted", by: "worker", noteRequired: false },
  { from: "submitted", to: "accepted", by: "manager", noteRequired: false },
  { from: "submitted", to: "rejected", by: "manager", noteRequired: true },
  { from: "accepted", to: "resolved", by: "manager", noteRequired: true },
];

async function transition(
  db: Db,
  args: { queryId: string; to: Transition["to"]; by: "worker" | "manager"; actor: string; workerId?: string; note?: string },
) {
  return db.transaction(async (tx) => {
    const [q] = await tx.select().from(s.payQueries).where(eq(s.payQueries.id, args.queryId)).for("update");
    if (!q || (args.workerId && q.workerId !== args.workerId)) throw new PayQueryError("Query not found", "not_found");
    // Idempotent re-send (e.g. clicked in both the chat card and the list): no change, no new audit entry.
    if (args.to === "submitted" && q.status === "submitted") return q;
    const rule = TRANSITIONS.find((t) => t.from === q.status && t.to === args.to && t.by === args.by);
    if (!rule) throw new PayQueryError(`A ${q.status} query can't be moved to ${args.to}`, "transition");
    const note = cleanText(args.note, 1000);
    if (rule.noteRequired && note.length < 3) throw new PayQueryError("Please add a short note", "invalid");

    const now = new Date();
    const [updated] = await tx
      .update(s.payQueries)
      .set({
        status: args.to,
        updatedAt: now,
        ...(args.to === "submitted" ? { submittedAt: now } : { reviewedAt: now, reviewedBy: args.actor }),
        ...(note ? { resolutionNote: note } : {}),
      })
      // Optimistic guard: only if still in the state we validated.
      .where(and(eq(s.payQueries.id, q.id), eq(s.payQueries.status, q.status)))
      .returning();
    if (!updated) throw new PayQueryError("This query was changed by someone else — reload", "transition");
    await tx.insert(s.auditLog).values({
      actor: args.actor,
      action: `pay_query.${args.to}`,
      entity: "pay_query",
      entityId: q.id,
      data: { from: q.status, to: args.to, note: note || null },
    });
    return updated;
  });
}

export const submitPayQuery = (db: Db, workerId: string, queryId: string) =>
  transition(db, { queryId, to: "submitted", by: "worker", actor: `worker:${workerId}`, workerId });

export const reviewPayQuery = (db: Db, queryId: string, to: "accepted" | "rejected" | "resolved", actor: string, note?: string) =>
  transition(db, { queryId, to, by: "manager", actor, note });

export async function listWorkerPayQueries(db: Db, workerId: string) {
  return db.select().from(s.payQueries).where(eq(s.payQueries.workerId, workerId)).orderBy(desc(s.payQueries.createdAt));
}

/** Manager inbox: everything except the worker's private drafts. */
export async function listManagerPayQueries(db: Db) {
  return db
    .select({ q: s.payQueries, workerName: s.workers.name })
    .from(s.payQueries)
    .innerJoin(s.workers, eq(s.workers.id, s.payQueries.workerId))
    .where(inArray(s.payQueries.status, ["submitted", "accepted", "resolved", "rejected"]))
    .orderBy(desc(s.payQueries.submittedAt));
}
