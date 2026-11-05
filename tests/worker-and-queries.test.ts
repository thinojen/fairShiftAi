/** Worker read model, Sam's comparison, and the pay query workflow — on PGlite. */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/connect";
import * as s from "@/lib/db/schema";
import { seedDemo } from "@/lib/db/seed";
import {
  createPayQueryDraft,
  listManagerPayQueries,
  proposePayQuery,
  reviewPayQuery,
  submitPayQuery,
} from "@/lib/payqueries/commands";
import { correctAssignmentTime, saveAllocation } from "@/lib/shifts/commands";
import { comparePeriods } from "@/lib/tips/compare";
import { getWorkerOverview, getWorkerShifts, shiftEndsAt, venueLocalToUtc } from "@/lib/worker/queries";
import { FactLedger } from "@/lib/assistant/facts";
import { executeTool, type ToolContext } from "@/lib/assistant/tools";
import { createTestDb, TEST_RECIPIENTS } from "./helpers/pglite";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => ({ db, close } = await createTestDb()), 30_000);
afterEach(async () => close());

const M = "demo-manager";
const fixSam = () =>
  correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-30T23:30:00Z", reason: "No clock-out recorded; set to rota end", actor: M });

describe("worker read model", () => {
  it("seeded state: 23 Oct provisional £266.46 (v1), 30 Oct blocked, 6 Nov upcoming", async () => {
    const shifts = await getWorkerShifts(db, "w_sam", { now: new Date("2026-11-05T00:29:00Z") });
    const by = Object.fromEntries(shifts.map((x) => [x.date, x]));
    expect(by["2026-10-23"]).toMatchObject({ state: "provisional", sharePence: 26646, workedMinutes: 450, locked: false, policy: { version: 1 } });
    expect(by["2026-10-30"]).toMatchObject({ state: "blocked", sharePence: null, policy: { version: 2 } });
    expect(by["2026-10-30"].blockedReasons).toEqual(["Your clock-out is missing"]);
    expect(by["2026-11-06"].state).toBe("upcoming");
  });

  it("never names other workers in a worker's view", async () => {
    const priya = await getWorkerShifts(db, "w_priya");
    const oct30 = priya.find((x) => x.date === "2026-10-30")!;
    expect(oct30.blockedReasons).toEqual(["A team member's clock-out is missing"]);
    expect(JSON.stringify(priya)).not.toMatch(/Sam|Okafor|w_sam/);
  });

  it("only returns the requested worker's shifts", async () => {
    const sam = await getWorkerShifts(db, "w_sam");
    const priya = await getWorkerShifts(db, "w_priya");
    expect(sam.every((x) => x.assignmentId.endsWith("_sam"))).toBe(true);
    expect(priya.every((x) => x.assignmentId.endsWith("_priya"))).toBe(true);
    expect(await getWorkerShifts(db, "w_nobody")).toEqual([]);
  });

  it("separates provisional, allocated and paid totals", async () => {
    await saveAllocation(db, "sh_2026-10-23_dinner", M);
    const o = (await getWorkerOverview(db, "w_sam"))!;
    expect(o.totals.allocatedPence).toBe(26646); // locked 23 Oct
    // 24 Oct still provisional: 71250·55200/129500 = 30370.9 → 30370 + 1 remainder penny.
    expect(o.totals.provisionalPence).toBe(30371);
    expect(o.totals.paidPence).toBe(0); // nothing paid
    expect(o.shifts.find((x) => x.date === "2026-10-23")!.state).toBe("allocated");
  });
});

describe("Sam's Friday comparison", () => {
  it("is NOT comparable while 30 Oct is blocked — no invented figures", async () => {
    const o = (await getWorkerOverview(db, "w_sam"))!;
    expect(o.weekOnWeek!.earlier.date).toBe("2026-10-23");
    expect(o.weekOnWeek!.later.date).toBe("2026-10-30");
    const c = o.weekOnWeek!.comparison;
    expect(c.comparable).toBe(false);
    if (!c.comparable) expect(c.reason).toMatch(/2026-10-30.*incomplete/);
  });

  it("after the fix: provisional −£111.69 with the exact fixed-order steps", async () => {
    await fixSam();
    const c = (await getWorkerOverview(db, "w_sam"))!.weekOnWeek!.comparison;
    if (!c.comparable) throw new Error(c.reason);
    expect(c.provisional).toBe(true);
    expect(c.a).toMatchObject({ sharePence: 26646, grossPence: 64000, policyVersion: 1, workerMinutes: 450, workerPoints: 54000, totalPoints: 129700 });
    expect(c.b).toMatchObject({ sharePence: 15477, grossPence: 51000, policyVersion: 2, workerMinutes: 360, workerPoints: 43200, totalPoints: 142350 });
    expect(c.deltaPence).toBe(-11169);
    // Hand-checked: floor(51000·54000/129700)=21233; floor(51000·43200/118900)=18529 (118900·18530 > 2,203,200,000).
    expect(c.steps.map((x) => [x.key, x.deltaPence])).toEqual([["pool", -5413], ["your_points", -2704], ["team_points", -3052]]);
    expect(c.steps.reduce((n, x) => n + x.deltaPence, 0)).toBe(-11169);
    expect(c.policyChanges).toEqual([{ role: "host", fromBp: 60, toBp: 70 }]);
    expect(c.deltaWorkerMinutes).toBe(-90);
    expect(c.pointsShareA_bp).toBe(4163);
    expect(c.pointsShareB_bp).toBe(3035);
  });

  it("once both are locked: same exact figures, no longer provisional", async () => {
    await fixSam();
    await saveAllocation(db, "sh_2026-10-23_dinner", M);
    await saveAllocation(db, "sh_2026-10-30_dinner", M);
    const c = (await getWorkerOverview(db, "w_sam"))!.weekOnWeek!.comparison;
    if (!c.comparable) throw new Error(c.reason);
    expect(c.provisional).toBe(false);
    expect(c.a.state).toBe("allocated");
    expect(c.b.state).toBe("allocated");
    expect(c.deltaPence).toBe(-11169);
  });

  it("steps always sum to the actual difference (randomised)", () => {
    let seed = 7;
    const r = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 300; i++) {
      const mk = (gross: number, pts: number, total: number, share: number) => ({
        shiftId: "x", date: "2026-01-01", service: "dinner", state: "allocated" as const, policyId: "p", policyVersion: 1, weightsBp: null,
        grossPence: gross, workerMinutes: 1, workerWeightBp: 1, workerPoints: pts, totalPoints: total, sharePence: share, eligibleCount: 2,
      });
      const pA = 1 + r(50000), PA = pA + r(200000), gA = r(500000);
      const pB = 1 + r(50000), PB = pB + r(200000), gB = r(500000);
      const c = comparePeriods(mk(gA, pA, PA, Math.floor((gA * pA) / PA)), mk(gB, pB, PB, Math.floor((gB * pB) / PB)));
      if (!c.comparable) throw new Error();
      expect(c.steps.reduce((n, x) => n + x.deltaPence, 0)).toBe(c.deltaPence);
    }
  });
});

describe("pay queries", () => {
  const extraHour = { shiftAssignmentId: "sa_1030_sam", field: "clock_out" as const, adjustMinutes: 60, workerStatement: "I actually worked an extra hour, closing the bar" };

  it("a proposal computes the claim deterministically and writes nothing", async () => {
    await fixSam();
    const p = await proposePayQuery(db, "w_sam", extraHour);
    expect(p.recordedValue).toBe("2026-10-30T23:30:00.000Z");
    expect(p.claimedValue).toBe("2026-10-31T00:30:00.000Z");
    expect(p.differenceLabel).toBe("+1h");
    expect(p.evidence.original).toMatchObject({ clockOut: null, hoursCorrected: true });
    expect(p.evidence.corrections).toHaveLength(1);
    expect(p.evidence.allocation).toMatchObject({ state: "provisional", sharePence: 15477, policyVersion: 2 });
    expect(p.evidence.payout).toBeNull();
    expect(await db.select().from(s.payQueries)).toHaveLength(0);
  });

  it("cannot be raised on another worker's shift (same 'not found' answer)", async () => {
    await expect(proposePayQuery(db, "w_priya", extraHour)).rejects.toMatchObject({ code: "not_found" });
    await expect(proposePayQuery(db, "w_sam", { ...extraHour, shiftAssignmentId: "sa_1030_priya" })).rejects.toMatchObject({ code: "not_found" });
    await expect(proposePayQuery(db, "w_sam", { ...extraHour, shiftAssignmentId: "' OR 1=1 --" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("validates claims", async () => {
    await expect(proposePayQuery(db, "w_sam", { ...extraHour, adjustMinutes: 0 })).rejects.toMatchObject({ code: "invalid" });
    await expect(proposePayQuery(db, "w_sam", { ...extraHour, adjustMinutes: 9999 })).rejects.toMatchObject({ code: "invalid" });
    // Missing clock-out can't be "adjusted" — needs an exact time.
    await expect(proposePayQuery(db, "w_sam", extraHour)).rejects.toThrow(/no recorded time/);
    const p = await proposePayQuery(db, "w_sam", { ...extraHour, adjustMinutes: null, claimedTime: "00:30" });
    expect(p.claimedValue).toBe("2026-10-31T00:30:00.000Z");
  });

  it("draft → submitted → accepted → resolved, all audited, nothing financial changes", async () => {
    await fixSam();
    await saveAllocation(db, "sh_2026-10-30_dinner", M);
    const before = await db.select().from(s.allocations);
    const sa = (await db.select().from(s.shiftAssignments).where(eq(s.shiftAssignments.id, "sa_1030_sam")))[0];

    const q = await createPayQueryDraft(db, "w_sam", { ...extraHour, aiSummary: "Sam says he closed the bar." });
    expect(q.status).toBe("draft");
    expect(q.allocationId).toBeTruthy();
    expect(await listManagerPayQueries(db)).toHaveLength(0); // drafts are private
    await submitPayQuery(db, "w_sam", q.id);
    expect((await listManagerPayQueries(db))[0].q.status).toBe("submitted");
    await reviewPayQuery(db, q.id, "accepted", M);
    await reviewPayQuery(db, q.id, "resolved", M, "Corrected clock-out via the audited correction flow");

    const actions = (await db.select().from(s.auditLog)).map((a) => a.action).filter((a) => a.startsWith("pay_query."));
    expect(actions).toEqual(["pay_query.draft_created", "pay_query.submitted", "pay_query.accepted", "pay_query.resolved"]);
    expect(await db.select().from(s.allocations)).toEqual(before);
    expect((await db.select().from(s.shiftAssignments).where(eq(s.shiftAssignments.id, "sa_1030_sam")))[0]).toEqual(sa);
  });

  it("rejects invalid transitions and other workers' queries", async () => {
    await fixSam();
    const q = await createPayQueryDraft(db, "w_sam", extraHour);
    await expect(reviewPayQuery(db, q.id, "accepted", M)).rejects.toMatchObject({ code: "transition" }); // still a draft
    await expect(submitPayQuery(db, "w_priya", q.id)).rejects.toMatchObject({ code: "not_found" });
    await submitPayQuery(db, "w_sam", q.id);
    await expect(submitPayQuery(db, "w_sam", q.id)).resolves.toMatchObject({ status: "submitted" }); // idempotent re-send
    expect((await db.select().from(s.auditLog)).filter((a) => a.action === "pay_query.submitted")).toHaveLength(1);
    await expect(reviewPayQuery(db, q.id, "rejected", M, "")).rejects.toMatchObject({ code: "invalid" }); // note required
    await expect(reviewPayQuery(db, q.id, "resolved", M, "skip ahead")).rejects.toMatchObject({ code: "transition" });
  });

  it("one open query per shift; a rejected one no longer blocks a new query", async () => {
    await fixSam();
    const q = await createPayQueryDraft(db, "w_sam", extraHour);
    await expect(createPayQueryDraft(db, "w_sam", extraHour)).rejects.toMatchObject({ code: "duplicate" });
    // DB-level guarantee too, even if the app check were bypassed:
    await expect(
      db.insert(s.payQueries).values({ workerId: "w_sam", shiftAssignmentId: "sa_1030_sam", field: "clock_out", claimedValue: "x", workerMessage: "x", status: "submitted" }),
    ).rejects.toThrow();
    await submitPayQuery(db, "w_sam", q.id);
    await reviewPayQuery(db, q.id, "rejected", M, "Rota and till close confirm 23:30");
    await expect(createPayQueryDraft(db, "w_sam", extraHour)).resolves.toMatchObject({ status: "draft" });
  });

  it("pay queries are permanent and block reseeding", async () => {
    await fixSam();
    await createPayQueryDraft(db, "w_sam", extraHour);
    await expect(db.delete(s.payQueries)).rejects.toThrow();
    await expect(seedDemo(db, { recipientsCsv: TEST_RECIPIENTS.join(",") })).rejects.toThrow(/Refusing/);
  });
});

// ---------------------------------------------------------------------------
// Regression: on the live site (5 Nov) the dashboard compared 30 Oct with the
// FUTURE 6 Nov shift (£0 pool) as a £154.77 "decrease", and counted 6 Nov's
// recorded times as hours worked. "Has it happened?" is now decided by the clock
// (rota end, venue time), never by whether times happen to be recorded.

describe("future vs completed shifts", () => {
  const NOV_5 = new Date("2026-11-05T00:29:00Z"); // when the bug was seen
  const NOV_12 = new Date("2026-11-12T12:00:00Z"); // hackathon demo day: 6 Nov has passed
  /** The live data: someone recorded clock times on Sam's 6 Nov shift before it happened. */
  const recordFutureTimes = async () => {
    await correctAssignmentTime(db, { assignmentId: "sa_1106_sam", field: "clock_in", value: "2026-11-06T17:00:00Z", reason: "Entered ahead of the shift", actor: M });
    await correctAssignmentTime(db, { assignmentId: "sa_1106_sam", field: "clock_out", value: "2026-11-06T23:00:00Z", reason: "Entered ahead of the shift", actor: M });
  };
  const toolCtx = (now: Date): ToolContext => ({ db, workerId: "w_sam", ledger: new FactLedger(), proposals: [], now });

  it("a future shift with recorded times stays Upcoming: no hours worked, no share, not compared", async () => {
    await fixSam();
    await recordFutureTimes();
    const o = (await getWorkerOverview(db, "w_sam", { now: NOV_5 }))!;
    const nov6 = o.shifts.find((x) => x.date === "2026-11-06")!;
    expect(nov6).toMatchObject({ state: "upcoming", completed: false, comparisonEligible: false, workedMinutes: null, sharePence: null });
    expect(nov6.clockIn).not.toBeNull(); // the recorded evidence is kept, just not counted

    // Hours worked = completed shifts only (computed, not hard-coded).
    const done = o.shifts.filter((x) => x.completed);
    expect(done.map((x) => x.date).sort()).toEqual(["2026-10-23", "2026-10-24", "2026-10-30"]);
    expect(o.totals.workedMinutes).toBe(done.reduce((n, x) => n + (x.workedMinutes ?? 0), 0));
    expect(o.totals.workedMinutes).toBe(450 + 460 + 360); // 7h30 + 7h40 + 6h, not +5h30 from 6 Nov

    // The comparison is the two most recent completed Fridays.
    expect(o.weekOnWeek!.earlier.date).toBe("2026-10-23");
    expect(o.weekOnWeek!.later.date).toBe("2026-10-30");
    const c = o.weekOnWeek!.comparison;
    if (!c.comparable) throw new Error("expected comparable");
    expect(c.deltaPence).toBe(o.weekOnWeek!.later.sharePence! - o.weekOnWeek!.earlier.sharePence!);
    expect(c.deltaPence).toBeLessThan(0);
    expect(c.b.sharePence).not.toBe(0); // never the £0 future pool
  });

  it("before anything is recorded, 6 Nov is still Upcoming and excluded", async () => {
    await fixSam();
    const o = (await getWorkerOverview(db, "w_sam", { now: NOV_5 }))!;
    expect(o.shifts.find((x) => x.date === "2026-11-06")!.state).toBe("upcoming");
    expect([o.weekOnWeek!.earlier.date, o.weekOnWeek!.later.date]).toEqual(["2026-10-23", "2026-10-30"]);
  });

  it("after 6 Nov has passed but its tips aren't recorded, it isn't '£0 earned' and isn't compared", async () => {
    await fixSam();
    await recordFutureTimes();
    const o = (await getWorkerOverview(db, "w_sam", { now: NOV_12 }))!;
    const nov6 = o.shifts.find((x) => x.date === "2026-11-06")!;
    expect(nov6).toMatchObject({ completed: true, comparisonEligible: false, state: "blocked", sharePence: null });
    expect(nov6.blockedReasons).toEqual(["The tip pool for this shift hasn't been recorded yet"]);
    expect([o.weekOnWeek!.earlier.date, o.weekOnWeek!.later.date]).toEqual(["2026-10-23", "2026-10-30"]);
    expect(o.totals.provisionalPence).toBe(o.shifts.filter((x) => x.state === "provisional").reduce((n, x) => n + x.sharePence!, 0));
  });

  it("once 6 Nov has passed AND its tips are recorded, it becomes the latest comparable Friday", async () => {
    await fixSam();
    await recordFutureTimes();
    await db.update(s.tipPools).set({ grossPence: 48000 }).where(eq(s.tipPools.shiftId, "sh_2026-11-06_dinner"));
    const o = (await getWorkerOverview(db, "w_sam", { now: NOV_12 }))!;
    expect(o.shifts.find((x) => x.date === "2026-11-06")).toMatchObject({ completed: true, comparisonEligible: true });
    expect([o.weekOnWeek!.earlier.date, o.weekOnWeek!.later.date]).toEqual(["2026-10-30", "2026-11-06"]);
  });

  it("a shift is finished exactly at its latest rota end", async () => {
    await fixSam();
    const end = shiftEndsAt("2026-10-30", [new Date("2026-10-30T23:30:00Z"), new Date("2026-10-30T23:00:00Z")]);
    expect(end.toISOString()).toBe("2026-10-30T23:30:00.000Z");
    const before = await getWorkerShifts(db, "w_sam", { now: new Date(end.getTime() - 60_000) });
    const at = await getWorkerShifts(db, "w_sam", { now: end });
    expect(before.find((x) => x.date === "2026-10-30")).toMatchObject({ completed: false, state: "upcoming" });
    expect(at.find((x) => x.date === "2026-10-30")).toMatchObject({ completed: true, state: "provisional" });
  });

  it("uses the venue's time zone (Europe/London, incl. BST) when there is no rota", () => {
    expect(venueLocalToUtc("2026-07-10", "06:00").toISOString()).toBe("2026-07-10T05:00:00.000Z"); // BST
    expect(venueLocalToUtc("2026-11-06", "06:00").toISOString()).toBe("2026-11-06T06:00:00.000Z"); // GMT
    expect(shiftEndsAt("2026-11-06", []).toISOString()).toBe("2026-11-07T06:00:00.000Z");
    expect(shiftEndsAt("2026-07-10", []).toISOString()).toBe("2026-07-11T05:00:00.000Z");
  });

  it("Gemini's tools follow the same rules: no comparison with a future shift, no hours or share for it", async () => {
    await fixSam();
    await recordFutureTimes();
    const ctx = toolCtx(NOV_5);
    const auto = await executeTool(ctx, "compare_periods", JSON.stringify({ earlier_shift_id: null, later_shift_id: null }));
    const out = auto.output as { comparable: boolean; earlier: { date: { fact: string } }; later: { date: { fact: string } } };
    expect(out.comparable).toBe(true);
    expect(ctx.ledger.get(out.earlier.date.fact)!.value).toBe("2026-10-23");
    expect(ctx.ledger.get(out.later.date.fact)!.value).toBe("2026-10-30");

    const ctx2 = toolCtx(NOV_5);
    const forced = await executeTool(ctx2, "compare_periods", JSON.stringify({ earlier_shift_id: "sh_2026-10-30_dinner", later_shift_id: "sh_2026-11-06_dinner" }));
    expect(forced.output).toMatchObject({ comparable: false, reason: expect.stringMatching(/hasn't happened yet/) });
    expect(JSON.stringify(forced.output)).not.toMatch(/difference_in_your_share|steps/);
    expect(ctx2.ledger.all().some((f) => f.label.startsWith("Change in"))).toBe(false);

    const ctx3 = toolCtx(NOV_5);
    const list = await executeTool(ctx3, "get_worker_shifts", "{}");
    const nov6 = (list.output as { shifts: Array<Record<string, unknown>> }).shifts.find((x) => x.shift_id === "sh_2026-11-06_dinner")!;
    expect(nov6).toMatchObject({ has_happened: false, hours_worked: expect.stringMatching(/hasn't happened/), your_share: expect.stringMatching(/hasn't happened yet \(not a loss\)/) });
    expect(ctx3.ledger.all().some((f) => f.source.id === "sh_2026-11-06_dinner" && f.label === "Hours worked")).toBe(false);
  });
});
