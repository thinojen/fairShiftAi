/**
 * The assistant's tools. Deterministic TypeScript over the database.
 *
 * Scoping: no tool accepts a worker id. The worker comes from the server-side
 * context; any shift id must be one of THAT worker's shifts, otherwise the tool
 * answers "not found" (identical for missing and other people's records).
 *
 * No tool writes to the database, and nothing here can reach PayPal (this
 * module must never import lib/paypal — enforced by ESLint).
 * create_pay_query only builds a PROPOSAL; the worker must click to save it.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/connect";
import * as s from "../db/schema";
import { formatDateTime, formatMinutes, formatShiftDate, formatWeight } from "../format";
import { formatGBP } from "../money";
import { PayQueryError, proposePayQuery, type PayQueryProposal } from "../payqueries/commands";
import { formatShareBp } from "../tips/compare";
import { compareWorkerShifts, getWorkerShifts, pickWeekOnWeek, type WorkerShift } from "../worker/queries";
import { FactLedger, type FactSource } from "./facts";
import { PAYOUT_STATUS_LABEL, STATE_LABEL } from "./labels";

export type ToolContext = {
  db: Db;
  workerId: string;
  ledger: FactLedger;
  proposals: PayQueryProposal[];
  /** The clock used to decide which shifts have finished (tests pin it; defaults to now). */
  now?: Date;
  /** Cached per turn. */
  shifts?: WorkerShift[];
};

type JsonSchema = Record<string, unknown>;
export type ToolDef = {
  name: string;
  description: string;
  parameters: JsonSchema;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
};

const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const nullableString = (description: string): JsonSchema => ({ type: ["string", "null"], description });
const nullableInt = (description: string): JsonSchema => ({ type: ["integer", "null"], description });

async function myShifts(ctx: ToolContext) {
  ctx.shifts ??= await getWorkerShifts(ctx.db, ctx.workerId, { now: ctx.now });
  return ctx.shifts;
}

const SHIFT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
class ToolInputError extends Error {}

async function findShift(ctx: ToolContext, shiftId: unknown): Promise<WorkerShift> {
  if (typeof shiftId !== "string" || !SHIFT_ID_RE.test(shiftId)) throw new ToolInputError("not_found: no shift with that id for this worker");
  const sh = (await myShifts(ctx)).find((x) => x.shiftId === shiftId);
  if (!sh) throw new ToolInputError("not_found: no shift with that id for this worker");
  return sh;
}

const shiftLabel = (sh: { date: string; service: string }) => `${formatShiftDate(sh.date)} ${sh.service}`;
const shiftSource = (sh: WorkerShift): FactSource => ({ type: "shift", id: sh.shiftId, label: shiftLabel(sh) });

function money(ctx: ToolContext, pence: number, label: string, source: FactSource) {
  return ctx.ledger.add({ kind: "money", display: formatGBP(pence), label, source, value: pence });
}

function stateFact(ctx: ToolContext, sh: WorkerShift) {
  let display = STATE_LABEL[sh.state];
  if (sh.state === "allocated" && sh.payout) display = `Allocated — ${PAYOUT_STATUS_LABEL[sh.payout.status] ?? sh.payout.status}`;
  return ctx.ledger.add({ kind: "status", display, label: "Status", source: shiftSource(sh), value: sh.state });
}

function shareFact(ctx: ToolContext, sh: WorkerShift) {
  if (sh.sharePence === null) return null;
  const label = sh.locked ? "Your allocated share (locked)" : "Your provisional share (not locked)";
  return money(ctx, sh.sharePence, label, sh.allocationId ? { type: "allocation", id: sh.allocationId, label: shiftLabel(sh) } : shiftSource(sh));
}

function shiftSummary(ctx: ToolContext, sh: WorkerShift) {
  const src = shiftSource(sh);
  const t = (d: Date | null, label: string) =>
    d ? ctx.ledger.add({ kind: "time", display: formatDateTime(d), label, source: src, value: d.toISOString() }) : "missing";
  return {
    shift_id: sh.shiftId,
    date: ctx.ledger.add({ kind: "date", display: formatShiftDate(sh.date), label: "Shift date", source: src, value: sh.date }),
    service: sh.service,
    role: sh.role,
    status: stateFact(ctx, sh),
    rota_start: t(sh.rotaStart, "Rota start"),
    rota_end: t(sh.rotaEnd, "Rota end"),
    clock_in: t(sh.clockIn, "Recorded clock-in"),
    clock_out: t(sh.clockOut, "Recorded clock-out"),
    break: ctx.ledger.add({ kind: "minutes", display: formatMinutes(sh.breakMinutes), label: "Break", source: src, value: sh.breakMinutes }),
    has_happened: sh.completed,
    hours_worked: !sh.completed
      ? "none yet — this shift hasn't happened (scheduled hours are not hours worked)"
      : sh.workedMinutes === null
        ? "unknown (incomplete record)"
        : ctx.ledger.add({ kind: "minutes", display: formatMinutes(sh.workedMinutes), label: "Hours worked", source: src, value: sh.workedMinutes }),
    hours_were_corrected_by_manager: sh.hoursCorrected,
    original_recorded_clock_out: sh.hoursCorrected
      ? sh.originalClockOut
        ? t(sh.originalClockOut, "Original recorded clock-out")
        : "missing (no clock-out was recorded)"
      : "unchanged",
    number_of_corrections: sh.correctionCount,
    blocked_reasons: sh.blockedReasons,
    policy_version: sh.policy
      ? ctx.ledger.add({ kind: "policy", display: `v${sh.policy.version}`, label: "Tipping policy", source: { type: "policy", id: sh.policy.id, label: `Policy v${sh.policy.version}` }, value: sh.policy.version })
      : "none",
    your_share: !sh.completed && !sh.locked ? "none — this shift hasn't happened yet (not a loss)" : (shareFact(ctx, sh) ?? "not calculated"),
    is_payment: sh.state === "paid",
  };
}

/** Compact per-shift view for compare_periods: only what a comparison explanation needs. */
function comparisonSide(ctx: ToolContext, sh: WorkerShift) {
  const src = shiftSource(sh);
  return {
    date: ctx.ledger.add({ kind: "date", display: formatShiftDate(sh.date), label: "Shift date", source: src, value: sh.date }),
    service: sh.service,
    status: stateFact(ctx, sh),
    policy_version: sh.policy
      ? ctx.ledger.add({ kind: "policy", display: `v${sh.policy.version}`, label: "Tipping policy", source: { type: "policy", id: sh.policy.id, label: `Policy v${sh.policy.version}` }, value: sh.policy.version })
      : "none",
    tip_pool: money(ctx, sh.grossPence, "Tip pool", { type: "tip_pool", id: sh.shiftId, label: `Tip pool, ${shiftLabel(sh)}` }),
    hours_worked:
      sh.workedMinutes === null
        ? "unknown (incomplete record)"
        : ctx.ledger.add({ kind: "minutes", display: formatMinutes(sh.workedMinutes), label: "Hours worked", source: src, value: sh.workedMinutes }),
    hours_were_corrected_by_manager: sh.hoursCorrected,
    your_share: shareFact(ctx, sh) ?? "not calculated",
  };
}

// ---------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    name: "get_worker_shifts",
    description:
      "List the current worker's own shifts (newest first) with status, recorded times, hours, policy version and share. Use this first to find shift ids.",
    parameters: obj({}),
    async run(ctx) {
      const shifts = await myShifts(ctx);
      return { shifts: shifts.map((sh) => shiftSummary(ctx, sh)) };
    },
  },
  {
    name: "get_tip_pool",
    description: "Tip pool for one of the worker's shifts: total pool, whether it is demonstration data, and how many staff were eligible.",
    parameters: obj({ shift_id: { type: "string", description: "A shift_id from get_worker_shifts" } }),
    async run(ctx, args) {
      const sh = await findShift(ctx, args.shift_id);
      const pool = await ctx.db.select().from(s.tipPools).where(eq(s.tipPools.shiftId, sh.shiftId));
      const src: FactSource = { type: "tip_pool", id: pool[0]?.id ?? sh.shiftId, label: `Tip pool, ${shiftLabel(sh)}` };
      return {
        shift_id: sh.shiftId,
        tip_pool: money(ctx, sh.grossPence, "Tip pool", src),
        is_demonstration_data: sh.isDemoPool,
        funded_via_paypal_orders: Boolean(pool[0]?.paypalOrderId),
        eligible_staff:
          sh.eligibleCount === null ? "not calculated (hours incomplete)" : ctx.ledger.add({ kind: "count", display: String(sh.eligibleCount), label: "Eligible staff", source: src, value: sh.eligibleCount }),
      };
    },
  },
  {
    name: "get_policy",
    description: "A tipping policy: role weights, minimum hours to qualify and its plain-English summary. Give a shift_id to get the policy that applied to it, or a version number.",
    parameters: obj({ shift_id: nullableString("A shift_id, or null"), version: nullableInt("A policy version number, or null") }),
    async run(ctx, args) {
      let policyId: string | null = null;
      if (args.shift_id != null) policyId = (await findShift(ctx, args.shift_id)).policy?.id ?? null;
      const venueOf = (await ctx.db.select({ venueId: s.workers.venueId }).from(s.workers).where(eq(s.workers.id, ctx.workerId)))[0]?.venueId;
      const policies = venueOf ? await ctx.db.select().from(s.tipPolicies).where(eq(s.tipPolicies.venueId, venueOf)) : [];
      const p =
        policyId ? policies.find((x) => x.id === policyId)
        : typeof args.version === "number" ? policies.find((x) => x.version === args.version)
        : [...policies].sort((a, b) => b.version - a.version)[0];
      if (!p) throw new ToolInputError("not_found: no such policy");
      const src: FactSource = { type: "policy", id: p.id, label: `Policy v${p.version}` };
      return {
        version: ctx.ledger.add({ kind: "policy", display: `v${p.version}`, label: "Policy version", source: src, value: p.version }),
        in_force_from: ctx.ledger.add({ kind: "date", display: formatShiftDate(p.effectiveFrom), label: "In force from", source: src, value: p.effectiveFrom }),
        method: "Each eligible person's points = minutes worked × role weight. Shares = pool × your points ÷ everyone's points, in whole pence; leftover pennies go to the largest remainders.",
        role_weights: Object.fromEntries(
          Object.entries(p.rules.weightsBp).map(([role, bp]) => [role, ctx.ledger.add({ kind: "weight", display: formatWeight(bp), label: `${role} weight`, source: src, value: bp })]),
        ),
        minimum_to_qualify: ctx.ledger.add({ kind: "minutes", display: formatMinutes(p.rules.minMinutesToQualify), label: "Minimum to qualify", source: src, value: p.rules.minMinutesToQualify }),
        summary_text_UNTRUSTED: p.textSummary.slice(0, 600),
      };
    },
  },
  {
    name: "get_allocation_breakdown",
    description: "How the worker's share for one shift was calculated: minutes, role weight, points, share of team points, and share. Says clearly if blocked, provisional or locked.",
    parameters: obj({ shift_id: { type: "string", description: "A shift_id from get_worker_shifts" } }),
    async run(ctx, args) {
      const sh = await findShift(ctx, args.shift_id);
      const src = shiftSource(sh);
      if (sh.state === "blocked" || sh.state === "upcoming") {
        return { shift_id: sh.shiftId, status: stateFact(ctx, sh), reasons: sh.blockedReasons, note: "No allocation exists for this shift. Do not state an amount." };
      }
      const pctBp = sh.points !== null && sh.totalPoints ? Math.round((sh.points * 10000) / sh.totalPoints) : 0;
      return {
        shift_id: sh.shiftId,
        status: stateFact(ctx, sh),
        locked_by_manager: sh.locked,
        policy_version: sh.policy ? ctx.ledger.add({ kind: "policy", display: `v${sh.policy.version}`, label: "Tipping policy", source: { type: "policy", id: sh.policy.id, label: `Policy v${sh.policy.version}` }, value: sh.policy.version }) : "none",
        minutes_worked: ctx.ledger.add({ kind: "minutes", display: formatMinutes(sh.workedMinutes ?? 0), label: "Hours counted", source: src, value: sh.workedMinutes }),
        your_role_weight: ctx.ledger.add({ kind: "weight", display: formatWeight(sh.weightBp ?? 0), label: "Your role weight", source: src, value: sh.weightBp }),
        your_points: ctx.ledger.add({ kind: "count", display: (sh.points ?? 0).toLocaleString("en-GB"), label: "Your points", source: src, value: sh.points }),
        team_points_total: ctx.ledger.add({ kind: "count", display: (sh.totalPoints ?? 0).toLocaleString("en-GB"), label: "Everyone's points", source: src, value: sh.totalPoints }),
        your_share_of_points: ctx.ledger.add({ kind: "percent", display: formatShareBp(pctBp), label: "Your share of the points", source: src, value: pctBp }),
        tip_pool: money(ctx, sh.grossPence, "Tip pool", { type: "tip_pool", id: sh.shiftId, label: `Tip pool, ${shiftLabel(sh)}` }),
        your_share: shareFact(ctx, sh),
        eligible: sh.eligible,
        excluded_reason: sh.excludedReason,
        is_payment: false,
        note: sh.locked ? "This is an allocation, not a payment, unless get_payout_status shows success." : "Provisional: may change until the manager locks it. Not a payment.",
      };
    },
  },
  {
    name: "get_payout_status",
    description: "PayPal payout status for one shift (or all shifts if shift_id is null). Only returns PayPal ids when a payout record exists.",
    parameters: obj({ shift_id: nullableString("A shift_id, or null for all shifts") }),
    async run(ctx, args) {
      const shifts = args.shift_id != null ? [await findShift(ctx, args.shift_id)] : (await myShifts(ctx)).filter((x) => x.state !== "upcoming");
      return {
        payouts: shifts.map((sh) => {
          if (!sh.payout) {
            return {
              shift_id: sh.shiftId,
              payout_exists: false,
              status: stateFact(ctx, sh),
              note: "No PayPal payout has been made for this shift. Any amount is an allocation or estimate, NOT a payment.",
            };
          }
          const src: FactSource = { type: "payout", id: sh.payout.paypalItemId ?? sh.shiftId, label: `PayPal payout, ${shiftLabel(sh)}` };
          const statusCode = sh.payout.reconciliationIssue ? "needs_review" : sh.payout.status;
          return {
            shift_id: sh.shiftId,
            payout_exists: true,
            payout_status: ctx.ledger.add({ kind: "status", display: PAYOUT_STATUS_LABEL[statusCode] ?? statusCode, label: "PayPal status", source: src, value: statusCode }),
            amount: money(ctx, sh.payout.amountPence, "Payout amount", src),
            paypal_batch_id: sh.payout.paypalBatchId ? ctx.ledger.add({ kind: "paypal_id", display: sh.payout.paypalBatchId, label: "PayPal batch id", source: src }) : "none yet",
            paypal_item_id: sh.payout.paypalItemId ? ctx.ledger.add({ kind: "paypal_id", display: sh.payout.paypalItemId, label: "PayPal item id", source: src }) : "none yet",
            paypal_transaction_id: sh.payout.paypalTransactionId ? ctx.ledger.add({ kind: "paypal_id", display: sh.payout.paypalTransactionId, label: "PayPal transaction id", source: src }) : "none",
            is_payment_completed: statusCode === "success",
          };
        }),
      };
    },
  },
  {
    name: "compare_periods",
    description:
      "Precomputed comparison of the worker's share between two shifts, with the full breakdown (both shifts' pool, hours, policy, share, and step-by-step effects). With both ids null it compares the latest shift with the same service a week earlier (e.g. this Friday vs last Friday). For any 'why did I earn less/more' question call ONLY this tool — no other tool is needed.",
    parameters: obj({
      earlier_shift_id: nullableString("Earlier shift_id, or null for automatic week-on-week"),
      later_shift_id: nullableString("Later shift_id, or null for automatic week-on-week"),
    }),
    async run(ctx, args) {
      let pair: { earlier: WorkerShift; later: WorkerShift } | null;
      if (args.earlier_shift_id != null && args.later_shift_id != null) {
        pair = { earlier: await findShift(ctx, args.earlier_shift_id), later: await findShift(ctx, args.later_shift_id) };
      } else {
        pair = pickWeekOnWeek(await myShifts(ctx));
      }
      if (!pair) return { comparable: false, reason: "There is no matching earlier shift to compare with." };
      const c = compareWorkerShifts(pair.earlier, pair.later);
      const src: FactSource = { type: "comparison", id: `${pair.earlier.shiftId}..${pair.later.shiftId}`, label: `${shiftLabel(pair.earlier)} vs ${shiftLabel(pair.later)}` };
      const side = (sh: WorkerShift) => comparisonSide(ctx, sh);
      if (!c.comparable) {
        return { comparable: false, reason: c.reason, earlier: side(pair.earlier), later: side(pair.later), note: "Do not state a difference or an amount for an incomplete shift." };
      }
      const signed = (p: number, label: string) =>
        ctx.ledger.add({ kind: "money", display: `${p < 0 ? "−" : "+"}${formatGBP(Math.abs(p))}`, label, source: src, value: p });
      const signedMin = (m: number, label: string) =>
        ctx.ledger.add({ kind: "minutes", display: `${m < 0 ? "−" : "+"}${formatMinutes(Math.abs(m))}`, label, source: src, value: m });
      return {
        comparable: true,
        method: "Fixed-order counterfactual: change the pool first, then your points, then the rest of the team. One fair way to attribute the change, not the only possible one.",
        figures_are_provisional: c.provisional,
        earlier: side(pair.earlier),
        later: side(pair.later),
        difference_in_your_share: signed(c.deltaPence, "Change in your share"),
        tip_pool_change: signed(c.deltaPoolPence, "Change in tip pool"),
        your_hours_change: signedMin(c.deltaWorkerMinutes, "Change in your hours"),
        your_share_of_points_earlier: ctx.ledger.add({ kind: "percent", display: formatShareBp(c.pointsShareA_bp), label: "Your share of points (earlier)", source: src, value: c.pointsShareA_bp }),
        your_share_of_points_later: ctx.ledger.add({ kind: "percent", display: formatShareBp(c.pointsShareB_bp), label: "Your share of points (later)", source: src, value: c.pointsShareB_bp }),
        rest_of_team_points_earlier: ctx.ledger.add({ kind: "count", display: c.otherPointsA.toLocaleString("en-GB"), label: "Rest of team's points (earlier)", source: src, value: c.otherPointsA }),
        rest_of_team_points_later: ctx.ledger.add({ kind: "count", display: c.otherPointsB.toLocaleString("en-GB"), label: "Rest of team's points (later)", source: src, value: c.otherPointsB }),
        eligible_staff_earlier: c.a.eligibleCount,
        eligible_staff_later: c.b.eligibleCount,
        steps: c.steps.map((st) => ({ step: st.key, explanation: st.label, effect: signed(st.deltaPence, `Effect: ${st.label}`) })),
        policy_weight_changes: c.policyChanges.map((pc) => ({
          role: pc.role,
          from: ctx.ledger.add({ kind: "weight", display: formatWeight(pc.fromBp), label: `${pc.role} weight before`, source: src, value: pc.fromBp }),
          to: ctx.ledger.add({ kind: "weight", display: formatWeight(pc.toBp), label: `${pc.role} weight after`, source: src, value: pc.toBp }),
        })),
        is_payment: false,
      };
    },
  },
  {
    name: "create_pay_query",
    description:
      "PREPARE (not save) a pay query when the worker says a recorded time or break is wrong. Returns a proposal card; the worker must click 'Create draft' themselves. For 'an extra hour' on clock-out use field=clock_out, adjust_minutes=60. Use claimed_time (HH:MM) if they give an exact time.",
    parameters: obj({
      shift_id: { type: "string", description: "A shift_id from get_worker_shifts" },
      field: { type: "string", enum: ["clock_in", "clock_out", "break_minutes"] },
      adjust_minutes: nullableInt("Minutes to add (+) or remove (−) from the recorded time, or null"),
      claimed_time: nullableString("Exact claimed time as HH:MM (24h, UK), or null"),
      claimed_break_minutes: nullableInt("Claimed break length in minutes (break_minutes only), or null"),
      worker_statement: { type: "string", description: "The worker's complaint in their own words (max 500 chars)" },
      summary: { type: "string", description: "A short neutral summary for the manager, with no amounts (max 600 chars)" },
    }),
    async run(ctx, args) {
      const sh = await findShift(ctx, args.shift_id);
      if (ctx.proposals.length >= 1) throw new ToolInputError("Only one pay query proposal per message.");
      const field = args.field;
      if (field !== "clock_in" && field !== "clock_out" && field !== "break_minutes") throw new ToolInputError("invalid field");
      try {
        const p = await proposePayQuery(ctx.db, ctx.workerId, {
          shiftAssignmentId: sh.assignmentId,
          field,
          adjustMinutes: typeof args.adjust_minutes === "number" ? args.adjust_minutes : null,
          claimedTime: typeof args.claimed_time === "string" ? args.claimed_time : null,
          claimedBreakMinutes: typeof args.claimed_break_minutes === "number" ? args.claimed_break_minutes : null,
          workerStatement: String(args.worker_statement ?? ""),
          aiSummary: typeof args.summary === "string" ? args.summary : null,
        });
        ctx.proposals.push(p);
        const src: FactSource = { type: "pay_query", id: `proposal:${sh.shiftId}`, label: `Pay query proposal, ${shiftLabel(sh)}` };
        return {
          proposal_ready: true,
          saved: false,
          next_step: "Show the worker the proposal. They must click 'Create draft', then 'Send to manager'. Nothing has been saved or changed.",
          recorded: ctx.ledger.add({ kind: "time", display: p.recordedLabel, label: "Recorded value", source: src }),
          claimed: ctx.ledger.add({ kind: "time", display: p.claimedLabel, label: "Claimed value", source: src }),
          difference: p.differenceLabel ? ctx.ledger.add({ kind: "minutes", display: p.differenceLabel, label: "Claimed difference", source: src }) : "n/a",
        };
      } catch (e) {
        if (e instanceof PayQueryError) return { proposal_ready: false, reason: e.message };
        throw e;
      }
    },
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** Execute one tool call safely. Unknown tools and bad input produce a data error, never an exception to the model loop. */
export async function executeTool(ctx: ToolContext, name: string, rawArgs: string): Promise<{ ok: boolean; output: unknown }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, output: { error: `Unknown tool "${String(name).slice(0, 40)}". Available: ${[...TOOL_NAMES].join(", ")}` } };
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawArgs || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    args = parsed;
  } catch {
    return { ok: false, output: { error: "Arguments must be a JSON object" } };
  }
  // Reject any attempt to pass identity: tools are always scoped server-side.
  const IDENTITY_KEY = /^(?:worker|user|employee|staff|account|person|venue)(?:_?id|_?email|_?name)?$|^(?:role|as_worker|impersonate)$/i;
  if (Object.keys(args).some((k) => IDENTITY_KEY.test(k))) {
    return { ok: false, output: { error: "Tools always act for the current worker only; identity arguments are not accepted." } };
  }
  try {
    return { ok: true, output: await tool.run(ctx, args) };
  } catch (e) {
    if (e instanceof ToolInputError) return { ok: false, output: { error: e.message } };
    throw e;
  }
}
