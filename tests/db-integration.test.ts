/**
 * Database integration tests on PGlite with the real migrations + seed.
 * These prove SQL/constraints/flows, NOT that live Supabase works.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/connect";
import * as s from "@/lib/db/schema";
import { seedDemo } from "@/lib/db/seed";
import { PayPalClient } from "@/lib/paypal/client";
import { loadPayPalConfig } from "@/lib/paypal/config";
import { assertPayoutAllowed } from "@/lib/paypal/guards";
import { paypalGateway } from "@/lib/payouts/gateway";
import { refreshShiftPayoutStatus, requestShiftPayout, STALE_CLAIM_MS } from "@/lib/payouts/service";
import { correctAssignmentTime, reopenShift, saveAllocation } from "@/lib/shifts/commands";
import { getDashboardSummary, getShiftReview, listShifts } from "@/lib/shifts/queries";
import { createFakePayPal } from "./helpers/fake-paypal";
import { createTestDb, TEST_RECIPIENTS } from "./helpers/pglite";

const FRI1 = "sh_2026-10-23_dinner";
const FRI2 = "sh_2026-10-30_dinner";
const MANAGER = "demo-manager";

let db: Db;
let close: () => Promise<void>;
let fake: ReturnType<typeof createFakePayPal>;
let gateway: ReturnType<typeof paypalGateway>;
let validate: (id: string, items: Parameters<typeof assertPayoutAllowed>[2]) => void;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  fake = createFakePayPal();
  const cfg = loadPayPalConfig({
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
    PAYPAL_SANDBOX_RECIPIENTS: TEST_RECIPIENTS.join(","),
    PAYOUT_MAX_ITEM_PENCE: "30000",
  });
  gateway = paypalGateway(new PayPalClient(cfg, fake.fetchImpl as unknown as typeof fetch), cfg);
  validate = (id, items) => assertPayoutAllowed(cfg, id, items);
}, 30_000);
afterEach(async () => close());

const fixSam = () =>
  correctAssignmentTime(db, {
    assignmentId: "sa_1030_sam",
    field: "clock_out",
    value: "2026-10-30T23:30:00Z",
    reason: "No clock-out recorded; set to scheduled end per rota",
    actor: MANAGER,
  });

describe("migrations + seed", () => {
  it("seed is repeatable and labels every pool as demo, unfunded", async () => {
    await seedDemo(db, { recipientsCsv: TEST_RECIPIENTS.join(",") });
    const pools = await db.select().from(s.tipPools);
    expect(pools).toHaveLength(4);
    expect(pools.every((p) => p.isDemo && p.paypalOrderId === null)).toBe(true);
    expect(await db.select().from(s.payouts)).toHaveLength(0);
    const sam = (await db.select().from(s.workers).where(eq(s.workers.id, "w_sam")))[0];
    expect(sam.paypalEmail).toBe(TEST_RECIPIENTS[0]);
  });

  it("lists shifts newest first with live counts", async () => {
    const rows = await listShifts(db);
    expect(rows[0].id).toBe("sh_2026-11-06_dinner");
    expect(rows.find((r) => r.id === FRI2)).toMatchObject({ staffCount: 5, grossPence: 51000, status: "open", isDemoPool: true });
    expect(rows.find((r) => r.id === "sh_2026-11-06_dinner")!.uncoveredCount).toBe(1);
  });
});

describe("shift review — Sam storyline from the database", () => {
  it("23 Oct uses policy v1 and gives Sam £266.46", async () => {
    const r = (await getShiftReview(db, FRI1))!;
    expect(r.policy!.version).toBe(1);
    expect(r.preview!.ok && r.preview!.workers.find((w) => w.workerId === "w_sam")!.sharePence).toBe(26646);
  });

  it("30 Oct uses v2, is blocked, and flags Sam's missing clock-out", async () => {
    const r = (await getShiftReview(db, FRI2))!;
    expect(r.policy!.version).toBe(2);
    expect(r.preview!.ok).toBe(false);
    expect(r.flags.map((f) => [f.type, f.workerId])).toEqual([["missing_clock_out", "w_sam"]]);
  });

  it("correcting the clock-out keeps the evidence and unblocks £154.77", async () => {
    await fixSam();
    const r = (await getShiftReview(db, FRI2))!;
    const sam = r.assignments.find((a) => a.id === "sa_1030_sam")!;
    expect(sam.hoursCorrected).toBe(true);
    expect(sam.originalClockOut).toBeNull(); // the original was MISSING — preserved as such
    expect(sam.clockOut!.toISOString()).toBe("2026-10-30T23:30:00.000Z");
    expect(sam.corrections).toHaveLength(1);
    expect(sam.corrections[0]).toMatchObject({ field: "clock_out", originalValue: null, newValue: "2026-10-30T23:30:00.000Z", actor: MANAGER });
    expect(sam.corrections[0].reason).toContain("scheduled end");
    expect(r.preview!.ok && r.preview!.workers.find((w) => w.workerId === "w_sam")!.sharePence).toBe(15477);
  });

  it("a second correction appends history and never overwrites the original evidence", async () => {
    await fixSam();
    await correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-31T00:30:00Z", reason: "Sam confirmed he closed the bar", actor: MANAGER });
    const sam = (await getShiftReview(db, FRI2))!.assignments.find((a) => a.id === "sa_1030_sam")!;
    expect(sam.originalClockOut).toBeNull();
    expect(sam.corrections.map((c) => [c.originalValue, c.newValue])).toEqual([
      [null, "2026-10-30T23:30:00.000Z"],
      ["2026-10-30T23:30:00.000Z", "2026-10-31T00:30:00.000Z"],
    ]);
  });

  it("rejects corrections without a reason or far outside the shift", async () => {
    await expect(correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-30T23:30:00Z", reason: "", actor: MANAGER })).rejects.toThrow(/reason/);
    await expect(correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-11-02T23:30:00Z", reason: "typo fix", actor: MANAGER })).rejects.toThrow(/12 hours/);
  });
});

describe("saving allocations", () => {
  it("refuses while blocked, then stores traces + policy refs and closes the shift", async () => {
    await expect(saveAllocation(db, FRI2, MANAGER)).rejects.toThrow(/clock-out/);
    await fixSam();
    await saveAllocation(db, FRI2, MANAGER);
    const r = (await getShiftReview(db, FRI2))!;
    expect(r.shift.status).toBe("closed");
    expect(r.saved).toHaveLength(5);
    expect(r.saved.reduce((n, a) => n + a.sharePence, 0)).toBe(51000);
    expect(r.saved.every((a) => a.policyId === "pol_v2")).toBe(true);
    expect(r.saved.find((a) => a.workerId === "w_sam")!.explanationJson).toMatchObject({ workedMinutes: 360, weightBp: 120, policy: { version: 2 } });
  });

  it("a later correction discards the saved allocation and reopens the shift", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    await correctAssignmentTime(db, { assignmentId: "sa_1023_alex", field: "break_minutes", value: "30", reason: "Break was 30 not 15", actor: MANAGER });
    const r = (await getShiftReview(db, FRI1))!;
    expect(r.shift.status).toBe("open");
    expect(r.saved).toHaveLength(0);
  });

  it("can be reopened while no payout exists", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    await reopenShift(db, FRI1, MANAGER);
    expect((await getShiftReview(db, FRI1))!.shift.status).toBe("open");
  });
});

describe("payouts — transaction safety", () => {
  const pay = () => requestShiftPayout(db, gateway, { shiftId: FRI1, actor: MANAGER, validate });

  it("requires a saved allocation", async () => {
    await expect(pay()).rejects.toMatchObject({ code: "not_ready" });
    expect(fake.createCalls).toBe(0);
  });

  it("persists sender_batch_id BEFORE calling PayPal and sends it as PayPal-Request-Id", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    let seenInDb: string | undefined;
    const spy: typeof gateway = {
      ...gateway,
      createBatch: async (id, items) => {
        seenInDb = (await db.select().from(s.payoutBatches))[0]?.senderBatchId;
        return gateway.createBatch(id, items);
      },
    };
    const out = await requestShiftPayout(db, spy, { shiftId: FRI1, actor: MANAGER, validate });
    expect(out.kind).toBe("accepted");
    expect(seenInDb).toBe(out.senderBatchId);
    const post = fake.fetchImpl.mock.calls.find(([, i]) => i?.method === "POST" && !String(i?.body).includes("grant_type"));
    expect((post![1]!.headers as Record<string, string>)["PayPal-Request-Id"]).toBe(out.senderBatchId);
  });

  it("two simultaneous approvals create ONE batch and ONE PayPal call", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    const results = await Promise.allSettled([pay(), pay()]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: expect.stringMatching(/in_progress|already_sent/) });
    expect(await db.select().from(s.payoutBatches)).toHaveLength(1);
    expect(fake.createCalls).toBe(1);
  });

  it("the DB refuses a second shift batch even if application checks were bypassed", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    await pay();
    await expect(
      db.insert(s.payoutBatches).values({ venueId: "v_copper_lantern", shiftId: FRI1, kind: "shift", senderBatchId: "manual-dup-0001", approvedBy: "x" }),
    ).rejects.toThrow();
  });

  it("never re-sends a batch PayPal has accepted", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    await pay();
    await expect(pay()).rejects.toMatchObject({ code: "already_sent" });
    expect(fake.createCalls).toBe(1);
  });

  it("uncertain failure → retry reuses the SAME sender_batch_id and PayPal returns the original batch", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    fake.failNextCreate("network");
    const first = await pay();
    expect(first.kind).toBe("uncertain");
    const [b1] = await db.select().from(s.payoutBatches);
    expect(b1.status).toBe("error");
    expect(b1.paypalBatchId).toBeNull();

    const second = await pay();
    expect(second).toMatchObject({ kind: "accepted", senderBatchId: first.senderBatchId, paypalBatchId: "PB1", attempt: 2 });
    expect(fake.batches.size).toBe(1); // PayPal-side: still exactly one batch
  });

  it("classifies PayPal rejections and server errors separately", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    fake.failNextCreate("422");
    expect((await pay()).kind).toBe("rejected");
    fake.failNextCreate("500");
    expect((await pay()).kind).toBe("uncertain");
  });

  it("a stale 'sending' claim (crashed request) can be retried; a fresh one cannot", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    fake.failNextCreate("network");
    await pay();
    const [b] = await db.select().from(s.payoutBatches);
    await db.update(s.payoutBatches).set({ status: "sending", updatedAt: new Date() }).where(eq(s.payoutBatches.id, b.id));
    await expect(pay()).rejects.toMatchObject({ code: "in_progress" });
    await db.update(s.payoutBatches).set({ updatedAt: new Date(Date.now() - STALE_CLAIM_MS - 1000) }).where(eq(s.payoutBatches.id, b.id));
    expect((await pay()).kind).toBe("accepted");
  });

  it("refuses an allocation that no longer matches the shift data", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    await db.update(s.tipPools).set({ grossPence: 99999 }).where(eq(s.tipPools.shiftId, FRI1));
    await expect(pay()).rejects.toMatchObject({ code: "stale_allocation" });
    expect(await db.select().from(s.payoutBatches)).toHaveLength(0);
  });

  it("pre-validates guards (allowlist/caps/batch total) before persisting anything", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    await db.update(s.workers).set({ paypalEmail: "not-allowlisted@example.com" }).where(eq(s.workers.id, "w_sam"));
    await expect(pay()).rejects.toMatchObject({ code: "guard" });
    expect(await db.select().from(s.payoutBatches)).toHaveLength(0);
    expect(fake.createCalls).toBe(0);
  });

  it("locks hours once a payout exists", async () => {
    await saveAllocation(db, FRI1, MANAGER);
    await pay();
    await expect(
      correctAssignmentTime(db, { assignmentId: "sa_1023_sam", field: "break_minutes", value: "45", reason: "late change", actor: MANAGER }),
    ).rejects.toThrow(/locked/);
    await expect(reopenShift(db, FRI1, MANAGER)).rejects.toThrow();
  });
});

describe("payout status reconciliation", () => {
  async function paidBatch() {
    await saveAllocation(db, FRI1, MANAGER);
    const out = await requestShiftPayout(db, gateway, { shiftId: FRI1, actor: MANAGER, validate });
    if (out.kind !== "accepted") throw new Error("expected accepted");
    return out;
  }
  const refresh = () => refreshShiftPayoutStatus(db, gateway, { shiftId: FRI1, actor: MANAGER });

  it("accepted batch: nobody is paid until their own item reports SUCCESS", async () => {
    await paidBatch();
    const r = await refresh();
    expect(r.items.every((p) => p.status === "pending")).toBe(true);
    expect(r.allPaid).toBe(false);
    expect((await getShiftReview(db, FRI1))!.shift.status).toBe("closed");
  });

  it("tracks mixed item outcomes separately and keeps PayPal ids", async () => {
    const out = await paidBatch();
    const rows = await db.select().from(s.payouts);
    const samRow = rows.find((p) => p.workerId === "w_sam")!;
    const alexRow = rows.find((p) => p.workerId === "w_alex")!;
    fake.settle(out.paypalBatchId, "SUCCESS", (id) => (id === samRow.senderItemId ? "UNCLAIMED" : id === alexRow.senderItemId ? "FAILED" : "SUCCESS"));
    const r = await refresh();
    const by = Object.fromEntries(r.items.map((p) => [p.workerId, p]));
    expect(by.w_sam.status).toBe("unclaimed");
    expect(by.w_alex.status).toBe("failed");
    expect(by.w_priya.status).toBe("success");
    expect(by.w_priya.paypalItemId).toMatch(/^PB1-I/);
    expect(by.w_priya.paypalTransactionId).toMatch(/^TX/);
    expect(r.allPaid).toBe(false); // batch SUCCESS ≠ everyone paid
    expect((await getShiftReview(db, FRI1))!.shift.status).toBe("closed");
  });

  it("marks the shift paid only when every item succeeds, and is idempotent", async () => {
    const out = await paidBatch();
    fake.settle(out.paypalBatchId, "SUCCESS", () => "SUCCESS");
    const r1 = await refresh();
    expect(r1).toMatchObject({ allPaid: true, changed: 4 });
    const r2 = await refresh();
    expect(r2.changed).toBe(0);
    expect((await getShiftReview(db, FRI1))!.shift.status).toBe("paid");
    const logs = await db.select().from(s.auditLog).where(and(eq(s.auditLog.action, "payout.status_refreshed")));
    expect(logs).toHaveLength(1);
  });

  it("dashboard counts only SUCCESS items as paid", async () => {
    const out = await paidBatch();
    const rows = await db.select().from(s.payouts);
    fake.settle(out.paypalBatchId, "SUCCESS", (id) => (id === rows[0].senderItemId ? "SUCCESS" : "PENDING"));
    await refresh();
    const d = await getDashboardSummary(db);
    expect(d.counts.paidPence).toBe(rows[0].amountPence);
  });
});
