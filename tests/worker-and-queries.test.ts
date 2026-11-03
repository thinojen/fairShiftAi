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
import { getWorkerOverview, getWorkerShifts } from "@/lib/worker/queries";
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
    const shifts = await getWorkerShifts(db, "w_sam");
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
