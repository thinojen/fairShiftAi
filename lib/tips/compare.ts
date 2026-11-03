/**
 * Deterministic comparison of one worker's share across two shifts. PURE.
 *
 * The difference is explained with a FIXED-ORDER COUNTERFACTUAL — one honest
 * way to attribute it, not the only mathematically possible one:
 *
 *   start        your actual share in period A
 *   step 1 pool  A's points, but B's tip pool            floor(gB·pA / PA)
 *   step 2 you   + your B points, team as in A            floor(gB·pB / (PA − pA + pB))
 *   step 3 team  + the rest of the team as in B           = your actual B share
 *                (staffing, hours, policy weight changes, and rounding pennies)
 *
 * The three steps always sum exactly to (share B − share A). BigInt throughout.
 */
import type { TipPolicyRules } from "../db/schema";

export type PeriodState = "upcoming" | "blocked" | "provisional" | "allocated" | "paid" | "needs_review";

export type PeriodFacts = {
  shiftId: string;
  date: string;
  service: string;
  state: PeriodState;
  policyId: string | null;
  policyVersion: number | null;
  weightsBp: TipPolicyRules["weightsBp"] | null;
  grossPence: number;
  /** Present when state is provisional/allocated/paid/needs_review. */
  workerMinutes: number | null;
  workerWeightBp: number | null;
  workerPoints: number | null;
  totalPoints: number | null;
  sharePence: number | null;
  eligibleCount: number | null;
};

export type ComparisonStep = {
  key: "pool" | "your_points" | "team_points";
  label: string;
  fromPence: number;
  toPence: number;
  deltaPence: number;
};

export type Comparison =
  | {
      comparable: true;
      method: "fixed_order_counterfactual";
      a: PeriodFacts;
      b: PeriodFacts;
      /** True if either side is a provisional (not yet locked) figure. */
      provisional: boolean;
      deltaPence: number;
      deltaPoolPence: number;
      deltaWorkerMinutes: number;
      deltaWorkerPoints: number;
      otherPointsA: number;
      otherPointsB: number;
      deltaOtherPoints: number;
      /** Share of the team's points, in basis points of a percent (1234 = 12.34%). */
      pointsShareA_bp: number;
      pointsShareB_bp: number;
      steps: ComparisonStep[];
      policyChanges: Array<{ role: string; fromBp: number; toBp: number }>;
    }
  | { comparable: false; a: PeriodFacts; b: PeriodFacts; reason: string };

const hasFigures = (p: PeriodFacts) =>
  p.sharePence !== null && p.workerPoints !== null && p.totalPoints !== null && p.workerMinutes !== null;

function floorDiv(n: bigint, d: bigint) {
  return d === BigInt(0) ? BigInt(0) : n / d;
}

function shareBp(points: number, total: number) {
  // Integer basis points of a percent, rounded half up: 41.63% → 4163.
  if (total <= 0) return 0;
  return Number((BigInt(points) * BigInt(20000) + BigInt(total)) / (BigInt(total) * BigInt(2)));
}

export function comparePeriods(a: PeriodFacts, b: PeriodFacts): Comparison {
  for (const [p, which] of [[a, "earlier"], [b, "later"]] as const) {
    if (p.state === "upcoming") return { comparable: false, a, b, reason: `The ${which} shift (${p.date}) hasn't happened yet.` };
    if (p.state === "blocked" || !hasFigures(p)) {
      return {
        comparable: false,
        a,
        b,
        reason: `The ${which} shift (${p.date}) can't be calculated yet: its hours are incomplete, so there is no allocation to compare.`,
      };
    }
  }

  const gB = BigInt(b.grossPence);
  const pA = BigInt(a.workerPoints!);
  const PA = BigInt(a.totalPoints!);
  const pB = BigInt(b.workerPoints!);
  const sA = a.sharePence!;
  const sB = b.sharePence!;

  const s1 = Number(floorDiv(gB * pA, PA));
  const s2 = Number(floorDiv(gB * pB, PA - pA + pB));

  const steps: ComparisonStep[] = [
    { key: "pool", label: "Tip pool size", fromPence: sA, toPence: s1, deltaPence: s1 - sA },
    { key: "your_points", label: "Your points (your minutes × your role weight)", fromPence: s1, toPence: s2, deltaPence: s2 - s1 },
    {
      key: "team_points",
      label: "Rest of the team's points (staffing, hours, policy weights, rounding)",
      fromPence: s2,
      toPence: sB,
      deltaPence: sB - s2,
    },
  ];

  const policyChanges: Array<{ role: string; fromBp: number; toBp: number }> = [];
  if (a.weightsBp && b.weightsBp) {
    for (const role of Object.keys(b.weightsBp) as Array<keyof TipPolicyRules["weightsBp"]>) {
      if (a.weightsBp[role] !== b.weightsBp[role]) policyChanges.push({ role, fromBp: a.weightsBp[role], toBp: b.weightsBp[role] });
    }
  }

  const otherA = a.totalPoints! - a.workerPoints!;
  const otherB = b.totalPoints! - b.workerPoints!;
  return {
    comparable: true,
    method: "fixed_order_counterfactual",
    a,
    b,
    provisional: a.state === "provisional" || b.state === "provisional",
    deltaPence: sB - sA,
    deltaPoolPence: b.grossPence - a.grossPence,
    deltaWorkerMinutes: b.workerMinutes! - a.workerMinutes!,
    deltaWorkerPoints: b.workerPoints! - a.workerPoints!,
    otherPointsA: otherA,
    otherPointsB: otherB,
    deltaOtherPoints: otherB - otherA,
    pointsShareA_bp: shareBp(a.workerPoints!, a.totalPoints!),
    pointsShareB_bp: shareBp(b.workerPoints!, b.totalPoints!),
    steps,
    policyChanges,
  };
}

/** 4163 → "41.63%" */
export function formatShareBp(bp: number) {
  return `${Math.floor(bp / 100)}.${(bp % 100).toString().padStart(2, "0")}%`;
}
