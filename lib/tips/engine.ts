/**
 * Deterministic tip allocation engine (SPEC §5 + Amendments).
 *
 * PURE: no database, no network, no AI. Every number FairShift pays or explains
 * comes from here. All arithmetic is integer; intermediate products use BigInt so
 * nothing can overflow or lose precision.
 *
 *   worked_minutes_i = floor((clock_out − clock_in) / 1 min) − break_minutes
 *   eligible_i       = status is "worked" AND worked_minutes_i ≥ policy minimum
 *   points_i         = worked_minutes_i × weight_bp(role_i)          (eligible only)
 *   share_i          = floor(gross × points_i / Σ points)
 *   leftover pence   → one each to the largest remainders
 *                      (ties: lower worker id first — deterministic)
 *
 * If any critical data is missing or invalid, NOTHING is calculated: the engine
 * returns `ok: false` with a list of blockers for the manager to fix.
 */
import type { TipPolicyRules } from "../db/schema";

export type Role = keyof TipPolicyRules["weightsBp"];

export type EngineAssignment = {
  assignmentId: string;
  workerId: string | null;
  workerName?: string;
  role: Role;
  status: "scheduled" | "worked" | "no_show" | "uncovered";
  clockIn: Date | null;
  clockOut: Date | null;
  breakMinutes: number;
};

export type EnginePolicy = { id: string; version: number; rules: TipPolicyRules };

export type BlockerCode =
  | "missing_clock_in"
  | "missing_clock_out"
  | "clock_out_before_clock_in"
  | "break_exceeds_shift"
  | "invalid_break"
  | "not_recorded"
  | "duplicate_worker"
  | "invalid_pool"
  | "invalid_weight"
  | "no_eligible_workers";

export type Blocker = { code: BlockerCode; assignmentId?: string; workerId?: string | null; message: string };

export type WorkerTrace = {
  workerId: string;
  workerName?: string;
  assignmentId: string;
  role: Role;
  workedMinutes: number;
  eligible: boolean;
  excludedReason?: string;
  weightBp: number;
  points: number;
  /** floor share before remainder distribution */
  baseSharePence: number;
  /** numerator remainder (gross × points mod Σpoints) as a string, for audit */
  remainder: string;
  /** 0 or 1 penny from largest-remainder distribution */
  remainderPence: number;
  sharePence: number;
};

export type AllocationResult =
  | {
      ok: true;
      grossPence: number;
      totalPoints: number;
      allocatedPence: number;
      policy: { id: string; version: number };
      workers: WorkerTrace[];
    }
  | { ok: false; blockers: Blocker[] };

const MINUTE_MS = 60_000;

/** Whole minutes between two instants (seconds are ignored), minus break. */
export function workedMinutes(clockIn: Date, clockOut: Date, breakMinutes: number): number {
  return Math.floor((clockOut.getTime() - clockIn.getTime()) / MINUTE_MS) - breakMinutes;
}

function label(a: EngineAssignment) {
  return a.workerName ?? a.workerId ?? a.assignmentId;
}

export function allocateTips(input: {
  grossPence: number;
  policy: EnginePolicy;
  assignments: EngineAssignment[];
}): AllocationResult {
  const { grossPence, policy } = input;
  const blockers: Blocker[] = [];

  if (!Number.isSafeInteger(grossPence) || grossPence < 0) {
    blockers.push({ code: "invalid_pool", message: `Tip pool must be a non-negative integer number of pence (got ${grossPence})` });
  }

  // Uncovered slots have no worker and earn nothing; they never block.
  const staffed = input.assignments.filter((a) => a.workerId !== null && a.status !== "uncovered");

  const seenWorkers = new Set<string>();
  const rows: Array<{ a: EngineAssignment; minutes: number }> = [];

  for (const a of staffed) {
    if (seenWorkers.has(a.workerId!)) {
      blockers.push({ code: "duplicate_worker", assignmentId: a.assignmentId, workerId: a.workerId, message: `${label(a)} appears more than once on this shift` });
      continue;
    }
    seenWorkers.add(a.workerId!);

    if (a.status === "no_show") {
      rows.push({ a, minutes: 0 });
      continue;
    }
    if (a.status === "scheduled" && !a.clockIn && !a.clockOut) {
      blockers.push({ code: "not_recorded", assignmentId: a.assignmentId, workerId: a.workerId, message: `${label(a)} has no recorded hours (mark as worked with times, or as a no-show)` });
      continue;
    }
    if (!a.clockIn) {
      blockers.push({ code: "missing_clock_in", assignmentId: a.assignmentId, workerId: a.workerId, message: `${label(a)} is missing a clock-in time` });
    }
    if (!a.clockOut) {
      blockers.push({ code: "missing_clock_out", assignmentId: a.assignmentId, workerId: a.workerId, message: `${label(a)} is missing a clock-out time` });
    }
    if (!Number.isSafeInteger(a.breakMinutes) || a.breakMinutes < 0) {
      blockers.push({ code: "invalid_break", assignmentId: a.assignmentId, workerId: a.workerId, message: `${label(a)} has an invalid break length` });
      continue;
    }
    if (!a.clockIn || !a.clockOut) continue;

    const gross = Math.floor((a.clockOut.getTime() - a.clockIn.getTime()) / MINUTE_MS);
    if (gross <= 0) {
      blockers.push({ code: "clock_out_before_clock_in", assignmentId: a.assignmentId, workerId: a.workerId, message: `${label(a)}'s clock-out is not after their clock-in` });
      continue;
    }
    if (a.breakMinutes >= gross) {
      blockers.push({ code: "break_exceeds_shift", assignmentId: a.assignmentId, workerId: a.workerId, message: `${label(a)}'s break is as long as or longer than their shift` });
      continue;
    }
    rows.push({ a, minutes: gross - a.breakMinutes });
  }

  for (const r of rows) {
    const w = policy.rules.weightsBp[r.a.role];
    if (!Number.isSafeInteger(w) || w < 0) {
      blockers.push({ code: "invalid_weight", workerId: r.a.workerId, message: `Policy v${policy.version} has no valid weight for role "${r.a.role}"` });
    }
  }

  const min = policy.rules.minMinutesToQualify;
  const scored = rows.map(({ a, minutes }) => {
    const weightBp = policy.rules.weightsBp[a.role] ?? 0;
    let excludedReason: string | undefined;
    if (a.status === "no_show") excludedReason = "No-show";
    else if (minutes < min) excludedReason = `Worked under the ${min}-minute minimum`;
    const eligible = !excludedReason;
    return { a, minutes, weightBp, eligible, excludedReason, points: eligible ? minutes * weightBp : 0 };
  });

  const totalPointsBig = scored.reduce((s, r) => s + BigInt(r.points), BigInt(0));
  if (blockers.length === 0 && totalPointsBig === BigInt(0) && grossPence > 0) {
    blockers.push({ code: "no_eligible_workers", message: "Nobody on this shift is eligible for the tip pool" });
  }
  if (blockers.length) return { ok: false, blockers };

  const gross = BigInt(grossPence);
  const zero = BigInt(0);
  const withShares = scored.map((r) => {
    const numerator = gross * BigInt(r.points);
    const base = totalPointsBig === zero ? zero : numerator / totalPointsBig;
    const rem = totalPointsBig === zero ? zero : numerator % totalPointsBig;
    return { ...r, base, rem, extra: 0 };
  });

  // With zero points (only possible when the pool is £0) there is nothing to distribute.
  const allocatedBase = withShares.reduce((s, r) => s + r.base, zero);
  const leftover = totalPointsBig === zero ? 0 : Number(gross - allocatedBase);

  const order = withShares
    .filter((r) => r.eligible)
    .sort((x, y) => (y.rem > x.rem ? 1 : y.rem < x.rem ? -1 : x.a.workerId! < y.a.workerId! ? -1 : 1));
  for (let i = 0; i < leftover; i++) order[i % order.length].extra += 1;

  const workers: WorkerTrace[] = withShares
    .map((r) => ({
      workerId: r.a.workerId!,
      workerName: r.a.workerName,
      assignmentId: r.a.assignmentId,
      role: r.a.role,
      workedMinutes: r.minutes,
      eligible: r.eligible,
      excludedReason: r.excludedReason,
      weightBp: r.weightBp,
      points: r.points,
      baseSharePence: Number(r.base),
      remainder: r.rem.toString(),
      remainderPence: r.extra,
      sharePence: Number(r.base) + r.extra,
    }))
    .sort((x, y) => (x.workerId < y.workerId ? -1 : 1));

  const allocatedPence = workers.reduce((s, w) => s + w.sharePence, 0);
  const totalPoints = Number(totalPointsBig);
  if (totalPoints > 0 && allocatedPence !== grossPence) {
    // Defensive: should be impossible. Never return a result that doesn't add up.
    throw new Error(`Allocation invariant violated: ${allocatedPence} ≠ ${grossPence}`);
  }

  return {
    ok: true,
    grossPence,
    totalPoints,
    allocatedPence,
    policy: { id: policy.id, version: policy.version },
    workers,
  };
}
