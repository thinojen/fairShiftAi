/**
 * Worker-scoped read model. Every function takes the workerId explicitly and
 * returns ONLY that worker's data (other workers appear only as aggregated
 * team totals, never by name). All figures come from the tip engine or stored
 * allocations/payouts — nothing is computed in the browser or by the AI.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/connect";
import * as s from "../db/schema";
import { allocateTips, type Blocker } from "../tips/engine";
import { comparePeriods, type Comparison, type PeriodFacts, type PeriodState } from "../tips/compare";
import { policyForDate } from "../tips/policy";

export type WorkerShift = {
  assignmentId: string;
  shiftId: string;
  date: string;
  service: string;
  role: string;
  rotaStart: Date;
  rotaEnd: Date;
  clockIn: Date | null;
  clockOut: Date | null;
  breakMinutes: number;
  hoursCorrected: boolean;
  originalClockOut: Date | null;
  correctionCount: number;
  workedMinutes: number | null;
  state: PeriodState;
  /** Plain-language reasons when blocked — never names other workers. */
  blockedReasons: string[];
  policy: { id: string; version: number; effectiveFrom: string } | null;
  weightsBp: s.TipPolicyRules["weightsBp"] | null;
  grossPence: number;
  isDemoPool: boolean;
  eligible: boolean | null;
  excludedReason: string | null;
  weightBp: number | null;
  points: number | null;
  totalPoints: number | null;
  eligibleCount: number | null;
  /** Calculated share (provisional or locked). NOT a payment. */
  sharePence: number | null;
  locked: boolean;
  allocationId: string | null;
  payout: {
    status: string;
    amountPence: number;
    paypalBatchId: string | null;
    paypalItemId: string | null;
    paypalTransactionId: string | null;
    reconciliationIssue: string | null;
    updatedAt: Date;
  } | null;
};

const BAD_PAYOUT = new Set(["failed", "unclaimed", "returned", "blocked", "refunded", "reversed"]);

function workerBlockerText(b: Blocker, workerId: string): string {
  const mine = b.workerId === workerId;
  switch (b.code) {
    case "missing_clock_out":
      return mine ? "Your clock-out is missing" : "A team member's clock-out is missing";
    case "missing_clock_in":
      return mine ? "Your clock-in is missing" : "A team member's clock-in is missing";
    case "not_recorded":
      return mine ? "Your hours haven't been recorded" : "A team member's hours haven't been recorded";
    case "clock_out_before_clock_in":
    case "break_exceeds_shift":
    case "invalid_break":
      return mine ? "Your recorded times don't add up" : "A team member's recorded times don't add up";
    case "no_eligible_workers":
      return "Nobody on this shift qualifies for the tip pool yet";
    default:
      return "The shift's records are incomplete";
  }
}

export async function getWorkerShifts(db: Db, workerId: string): Promise<WorkerShift[]> {
  const mine = await db.select().from(s.shiftAssignments).where(eq(s.shiftAssignments.workerId, workerId));
  if (!mine.length) return [];
  const shiftIds = [...new Set(mine.map((a) => a.shiftId))];

  const [shifts, pools, allAssignments, corrections, batches] = await Promise.all([
    db.select().from(s.shifts).where(inArray(s.shifts.id, shiftIds)),
    db.select().from(s.tipPools).where(inArray(s.tipPools.shiftId, shiftIds)),
    db.select().from(s.shiftAssignments).where(inArray(s.shiftAssignments.shiftId, shiftIds)),
    db.select().from(s.timeCorrections).where(inArray(s.timeCorrections.shiftAssignmentId, mine.map((a) => a.id))),
    db.select().from(s.payoutBatches).where(and(inArray(s.payoutBatches.shiftId, shiftIds), eq(s.payoutBatches.kind, "shift"))),
  ]);
  const venueIds = [...new Set(shifts.map((x) => x.venueId))];
  const policies = venueIds.length ? await db.select().from(s.tipPolicies).where(inArray(s.tipPolicies.venueId, venueIds)) : [];
  const poolIds = pools.map((p) => p.id);
  const allocations = poolIds.length
    ? await db.select().from(s.allocations).where(and(inArray(s.allocations.tipPoolId, poolIds), eq(s.allocations.workerId, workerId)))
    : [];
  const payouts = batches.length
    ? await db.select().from(s.payouts).where(and(inArray(s.payouts.batchId, batches.map((b) => b.id)), eq(s.payouts.workerId, workerId)))
    : [];

  const out: WorkerShift[] = [];
  for (const a of mine) {
    const shift = shifts.find((x) => x.id === a.shiftId)!;
    const pool = pools.find((p) => p.shiftId === shift.id);
    const policy = policyForDate(policies.filter((p) => p.venueId === shift.venueId), shift.date);
    const saved = pool ? allocations.find((x) => x.tipPoolId === pool.id) : undefined;
    const batch = batches.find((b) => b.shiftId === shift.id);
    const payout = batch ? payouts.find((p) => p.batchId === batch.id) : undefined;
    const workedMinutes =
      a.clockIn && a.clockOut ? Math.floor((a.clockOut.getTime() - a.clockIn.getTime()) / 60_000) - a.breakMinutes : null;

    const base = {
      assignmentId: a.id,
      shiftId: shift.id,
      date: shift.date,
      service: shift.service,
      role: a.role,
      rotaStart: a.scheduledStart,
      rotaEnd: a.scheduledEnd,
      clockIn: a.clockIn,
      clockOut: a.clockOut,
      breakMinutes: a.breakMinutes,
      hoursCorrected: a.hoursCorrected,
      originalClockOut: a.originalClockOut,
      correctionCount: corrections.filter((c) => c.shiftAssignmentId === a.id).length,
      workedMinutes,
      grossPence: pool?.grossPence ?? 0,
      isDemoPool: pool?.isDemo ?? false,
      policy: policy ? { id: policy.id, version: policy.version, effectiveFrom: policy.effectiveFrom } : null,
      weightsBp: policy?.rules.weightsBp ?? null,
      allocationId: saved?.id ?? null,
      payout: payout
        ? {
            status: payout.status,
            amountPence: payout.amountPence,
            paypalBatchId: batch?.paypalBatchId ?? null,
            paypalItemId: payout.paypalItemId,
            paypalTransactionId: payout.paypalTransactionId,
            reconciliationIssue: payout.reconciliationIssue,
            updatedAt: payout.updatedAt,
          }
        : null,
    };

    if (saved) {
      const trace = saved.explanationJson as { eligible?: boolean; excludedReason?: string; totalPoints?: number };
      const savedPolicy = policies.find((p) => p.id === saved.policyId);
      let state: PeriodState = "allocated";
      if (payout?.reconciliationIssue || (payout && BAD_PAYOUT.has(payout.status))) state = "needs_review";
      else if (payout?.status === "success") state = "paid";
      const eligibleCount = pool
        ? (await db.select({ id: s.allocations.id, points: s.allocations.points }).from(s.allocations).where(eq(s.allocations.tipPoolId, pool.id))).filter((x) => x.points > 0).length
        : null;
      out.push({
        ...base,
        policy: savedPolicy ? { id: savedPolicy.id, version: savedPolicy.version, effectiveFrom: savedPolicy.effectiveFrom } : base.policy,
        weightsBp: savedPolicy?.rules.weightsBp ?? base.weightsBp,
        workedMinutes: saved.workedMinutes,
        state,
        blockedReasons: [],
        eligible: trace.eligible ?? saved.points > 0,
        excludedReason: trace.excludedReason ?? null,
        weightBp: saved.weightBp,
        points: saved.points,
        totalPoints: trace.totalPoints ?? null,
        eligibleCount,
        sharePence: saved.sharePence,
        locked: true,
      });
      continue;
    }

    const upcoming = a.status === "scheduled" && !a.clockIn && !a.clockOut && (pool?.grossPence ?? 0) === 0;
    if (upcoming || !pool || !policy) {
      out.push({ ...base, state: upcoming ? "upcoming" : "blocked", blockedReasons: upcoming ? [] : ["No tip pool or policy for this shift"], eligible: null, excludedReason: null, weightBp: null, points: null, totalPoints: null, eligibleCount: null, sharePence: null, locked: false });
      continue;
    }

    const rows = allAssignments.filter((x) => x.shiftId === shift.id);
    const r = allocateTips({
      grossPence: pool.grossPence,
      policy: { id: policy.id, version: policy.version, rules: policy.rules },
      assignments: rows.map((x) => ({ assignmentId: x.id, workerId: x.workerId, role: x.role, status: x.status, clockIn: x.clockIn, clockOut: x.clockOut, breakMinutes: x.breakMinutes })),
    });
    if (!r.ok) {
      out.push({ ...base, state: "blocked", blockedReasons: [...new Set(r.blockers.map((b) => workerBlockerText(b, workerId)))], eligible: null, excludedReason: null, weightBp: null, points: null, totalPoints: null, eligibleCount: null, sharePence: null, locked: false });
      continue;
    }
    const w = r.workers.find((x) => x.workerId === workerId);
    out.push({
      ...base,
      state: "provisional",
      blockedReasons: [],
      workedMinutes: w?.workedMinutes ?? workedMinutes,
      eligible: w?.eligible ?? false,
      excludedReason: w?.excludedReason ?? null,
      weightBp: w?.weightBp ?? null,
      points: w?.points ?? 0,
      totalPoints: r.totalPoints,
      eligibleCount: r.workers.filter((x) => x.eligible).length,
      sharePence: w?.sharePence ?? 0,
      locked: false,
    });
  }
  return out.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : x.rotaStart < y.rotaStart ? 1 : -1));
}

export function toPeriodFacts(w: WorkerShift): PeriodFacts {
  const hasFigures = w.state !== "blocked" && w.state !== "upcoming";
  return {
    shiftId: w.shiftId,
    date: w.date,
    service: w.service,
    state: w.state,
    policyId: w.policy?.id ?? null,
    policyVersion: w.policy?.version ?? null,
    weightsBp: w.weightsBp,
    grossPence: w.grossPence,
    workerMinutes: hasFigures ? w.workedMinutes : null,
    workerWeightBp: hasFigures ? w.weightBp : null,
    workerPoints: hasFigures ? w.points : null,
    totalPoints: hasFigures ? w.totalPoints : null,
    sharePence: hasFigures ? w.sharePence : null,
    eligibleCount: hasFigures ? w.eligibleCount : null,
  };
}

function addDays(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * "This Friday vs last Friday": the worker's most recent non-upcoming shift and
 * the same service exactly 7 days earlier, if they worked it.
 */
export function pickWeekOnWeek(shifts: WorkerShift[]) {
  const latest = shifts.find((x) => x.state !== "upcoming");
  if (!latest) return null;
  const prior = shifts.find((x) => x.date === addDays(latest.date, -7) && x.service === latest.service);
  return prior ? { earlier: prior, later: latest } : null;
}

export function compareWorkerShifts(earlier: WorkerShift, later: WorkerShift): Comparison {
  return comparePeriods(toPeriodFacts(earlier), toPeriodFacts(later));
}

export async function getWorkerOverview(db: Db, workerId: string) {
  const [worker] = await db.select({ id: s.workers.id, name: s.workers.name, role: s.workers.role }).from(s.workers).where(eq(s.workers.id, workerId));
  if (!worker) return null;
  const shifts = await getWorkerShifts(db, workerId);
  const queries = await db.select().from(s.payQueries).where(eq(s.payQueries.workerId, workerId)).orderBy(asc(s.payQueries.createdAt));
  const pair = pickWeekOnWeek(shifts);

  const sum = (xs: WorkerShift[]) => xs.reduce((n, x) => n + (x.sharePence ?? 0), 0);
  const lockedShifts = shifts.filter((x) => x.locked);
  return {
    worker,
    shifts,
    payQueries: queries.reverse(),
    weekOnWeek: pair ? { ...pair, comparison: compareWorkerShifts(pair.earlier, pair.later) } : null,
    totals: {
      /** Locked allocations (whether or not paid yet). */
      allocatedPence: sum(lockedShifts),
      /** Only items PayPal reports as SUCCESS with no reconciliation issue. */
      paidPence: shifts
        .filter((x) => x.payout?.status === "success" && !x.payout.reconciliationIssue)
        .reduce((n, x) => n + x.payout!.amountPence, 0),
      /** Calculated but not locked — may still change. */
      provisionalPence: sum(shifts.filter((x) => x.state === "provisional")),
      blockedCount: shifts.filter((x) => x.state === "blocked").length,
      needsReviewCount: shifts.filter((x) => x.state === "needs_review").length,
      workedMinutes: shifts.reduce((n, x) => n + (x.state === "upcoming" ? 0 : (x.workedMinutes ?? 0)), 0),
    },
  };
}

export type WorkerOverview = NonNullable<Awaited<ReturnType<typeof getWorkerOverview>>>;
