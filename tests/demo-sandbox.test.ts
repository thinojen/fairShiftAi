/**
 * Isolated sandbox demo: local-only guard, setup (with Sam's accepted pay
 * query), a full rehearsal of the recording sequence against a FAKE PayPal,
 * and the read-only preflight. No real PayPal calls.
 */
import { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/connect";
import * as s from "@/lib/db/schema";
import { demoBannerLabel } from "@/lib/demo/banner";
import { DEMO_SHIFT_ID, explainDemoError, isLocalDatabaseUrl, assertLocalDatabase, runDemoSetup, runPreflight } from "@/lib/demo/sandbox";
import { reviewPayQuery } from "@/lib/payqueries/commands";
import { paypalGateway } from "@/lib/payouts/gateway";
import { refreshShiftPayoutStatus, requestShiftPayout } from "@/lib/payouts/service";
import { PayPalClient } from "@/lib/paypal/client";
import { loadPayPalConfig } from "@/lib/paypal/config";
import { assertPayoutAllowed } from "@/lib/paypal/guards";
import { correctAssignmentTime, saveAllocation } from "@/lib/shifts/commands";
import { getWorkerOverview } from "@/lib/worker/queries";
import { createFakePayPal } from "./helpers/fake-paypal";
import { TEST_RECIPIENTS } from "./helpers/pglite";

let db: Db;
let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
  db = drizzle({ client: pg, schema: s }) as unknown as Db;
  await migrate(drizzle({ client: pg }), { migrationsFolder: "./drizzle" });
}, 30_000);
afterEach(async () => pg.close());

const RECIPIENTS = TEST_RECIPIENTS.join(",");
const ENV = {
  DATABASE_URL: "postgres://postgres:fairshift-local@127.0.0.1:5432/postgres",
  DEMO_ENV_LABEL: "Isolated sandbox environment · synthetic data · PayPal SANDBOX",
  PAYOUTS_ENABLED: "true",
  MANAGER_APPROVAL_CODE: "demo-only-code-123",
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "sbx-SECRET-value-9f3k",
  PAYPAL_SANDBOX_RECIPIENTS: RECIPIENTS,
  PAYOUT_MAX_ITEM_PENCE: "20000",
  PAYOUT_MAX_BATCH_PENCE: "100000",
};
const okProbe = async () => ({ scopes: ["https://uri.paypal.com/payments/payouts"] });

async function counts() {
  const t = [s.payoutBatches, s.payouts, s.auditLog, s.allocations, s.payQueries, s.timeCorrections, s.shiftAssignments] as const;
  return Promise.all(t.map(async (x) => (await db.select({ n: count() }).from(x))[0].n));
}

describe("local-only guard", () => {
  it("accepts only databases on this machine", () => {
    for (const ok of ["postgres://postgres:pw@127.0.0.1:5432/postgres", "postgresql://u@localhost/db", "postgres://u@[::1]:5432/db"]) expect(isLocalDatabaseUrl(ok), ok).toBe(true);
    for (const bad of [
      "postgres://postgres.abcd:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres",
      "postgres://u:pw@db.abcd.supabase.co:5432/postgres",
      "postgres://localhost:pw@evil.example.com/db", // "localhost" as the USER, not the host
      "postgres://u@127.0.0.1.evil.example.com/db",
      "postgres://u@10.0.0.5/db",
      "postgres://u@db:5432/postgres",
      "mysql://u@localhost/db",
      "",
      undefined,
      "not a url",
    ]) {
      expect(isLocalDatabaseUrl(bad), String(bad)).toBe(false);
    }
    expect(() => assertLocalDatabase("postgres://u:pw@db.abcd.supabase.co:5432/postgres")).toThrow(/never on Supabase/);
  });

  it("explains common setup failures in plain English, never printing the database URL", () => {
    const refused = Object.assign(new Error("Failed query: CREATE SCHEMA"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }) });
    expect(explainDemoError(refused)).toBe("Can't connect to the local demo database. Start it with: npm run demo:db");
    const noTables = Object.assign(new Error("Failed query: select"), { cause: Object.assign(new Error('relation "workers" does not exist'), { code: "42P01" }) });
    expect(explainDemoError(noTables)).toBe("The demo tables don't exist yet. Run: npm run demo:setup");
    expect(explainDemoError(new Error("boom at postgres://u:secret@127.0.0.1/db"))).toBe("boom at [database url]");
  });

  it("the banner shows only when DEMO_ENV_LABEL is set (never on Render)", () => {
    expect(demoBannerLabel({})).toBeNull();
    expect(demoBannerLabel({ DEMO_ENV_LABEL: "  " })).toBeNull();
    expect(demoBannerLabel({ DEMO_ENV_LABEL: ENV.DEMO_ENV_LABEL })).toBe(ENV.DEMO_ENV_LABEL);
  });
});

describe("demo setup", () => {
  it("seeds, fixes Sam's missing clock-out to 23:30 and creates his accepted '+1 hour' query — via audited commands, no AI text invented", async () => {
    const r = await runDemoSetup(db, { recipientsCsv: RECIPIENTS });
    const [a] = await db.select().from(s.shiftAssignments).where(eq(s.shiftAssignments.id, "sa_1030_sam"));
    expect(a.clockOut?.toISOString()).toBe("2026-10-30T23:30:00.000Z");
    expect(a.originalClockOut).toBeNull(); // the missing original is preserved as evidence
    const [q] = await db.select().from(s.payQueries).where(eq(s.payQueries.id, r.queryId!));
    expect(q).toMatchObject({ workerId: "w_sam", status: "accepted", field: "clock_out", claimedValue: "2026-10-31T00:30:00.000Z", aiSummary: null, reviewedBy: "demo-manager" });
    const actions = (await db.select().from(s.auditLog)).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["hours.corrected", "pay_query.draft_created", "pay_query.submitted", "pay_query.accepted"]));
    expect((await counts()).slice(0, 2)).toEqual([0, 0]); // no payout batch, no payout
    // Sam's dashboard starts exactly like the public site: 23 Oct vs 30 Oct, provisional.
    const o = (await getWorkerOverview(db, "w_sam", { now: new Date("2026-11-05T12:00:00Z") }))!;
    expect([o.weekOnWeek!.earlier.date, o.weekOnWeek!.later.date]).toEqual(["2026-10-23", "2026-10-30"]);
  });

  it("can leave the query submitted (manager accepts on camera) or skip it", async () => {
    const r = await runDemoSetup(db, { recipientsCsv: RECIPIENTS, query: "submitted" });
    expect((await db.select().from(s.payQueries).where(eq(s.payQueries.id, r.queryId!)))[0].status).toBe("submitted");
  });

  it("refuses to run twice on the same database (reset the local DB for a new take)", async () => {
    await runDemoSetup(db, { recipientsCsv: RECIPIENTS });
    await expect(runDemoSetup(db, { recipientsCsv: RECIPIENTS })).rejects.toThrow(/already has demo data/);
  });
});

describe("rehearsal of the recording sequence (FAKE PayPal — proves the order works, not PayPal itself)", () => {
  it("accepted query → correction to 00:30 → resolve → lock → approve & pay once → refresh → Sam sees PayPal-confirmed payment", async () => {
    const { queryId } = await runDemoSetup(db, { recipientsCsv: RECIPIENTS });
    const NOW = { now: new Date("2026-11-05T12:00:00Z") };
    const before = (await getWorkerOverview(db, "w_sam", NOW))!.shifts.find((x) => x.date === "2026-10-30")!.sharePence!;

    // 5. The manager's correction follows the accepted query (allowed: no payout exists yet).
    await correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-31T00:30:00Z", reason: "Pay query accepted: worked an extra hour", actor: "demo-manager" });
    await reviewPayQuery(db, queryId!, "resolved", "demo-manager", "Clock-out corrected to 00:30");
    // 6. Recalculated by the engine.
    const after = (await getWorkerOverview(db, "w_sam", NOW))!.shifts.find((x) => x.date === "2026-10-30")!;
    expect(after.sharePence!).toBeGreaterThan(before);
    expect(after.workedMinutes).toBe(420);
    // 7. Lock.
    await saveAllocation(db, DEMO_SHIFT_ID, "demo-manager");

    // Preflight on the locked shift: passes, totals equal the pool, and writes nothing.
    const c0 = await counts();
    const pf = await runPreflight(db, ENV, okProbe);
    expect(pf.ok).toBe(true);
    const [pool] = await db.select().from(s.tipPools).where(eq(s.tipPools.shiftId, DEMO_SHIFT_ID));
    expect(pf.totalPence).toBe(pool.grossPence);
    expect(await counts()).toEqual(c0);

    // 8–9. Approve & pay (fake PayPal), then a second click: same batch, no second payment.
    const fake = createFakePayPal();
    const cfg = loadPayPalConfig(ENV);
    const gateway = paypalGateway(new PayPalClient(cfg, fake.fetchImpl as unknown as typeof fetch), cfg);
    const validate = (id: string, items: Parameters<typeof assertPayoutAllowed>[2]) => assertPayoutAllowed(cfg, id, items);
    const out = await requestShiftPayout(db, gateway, { shiftId: DEMO_SHIFT_ID, actor: "demo-manager", validate });
    expect(out.kind).toBe("accepted");
    await expect(requestShiftPayout(db, gateway, { shiftId: DEMO_SHIFT_ID, actor: "demo-manager", validate })).rejects.toThrow(/already accepted/);
    expect(fake.createCalls).toBe(1);
    expect(await db.select().from(s.payoutBatches)).toHaveLength(1);
    // Hours are now locked: no further correction is possible.
    await expect(correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-31T01:30:00Z", reason: "too late", actor: "m" })).rejects.toThrow(/hours are locked/);

    // Before PayPal reports anything, Sam is NOT shown as paid.
    expect((await getWorkerOverview(db, "w_sam", NOW))!.totals.paidPence).toBe(0);

    // 10. PayPal reports SUCCESS → refresh.
    fake.settle([...fake.batches.keys()][0], "SUCCESS", () => "SUCCESS");
    const r = await refreshShiftPayoutStatus(db, gateway, { shiftId: DEMO_SHIFT_ID, actor: "demo-manager" });
    expect(r.allPaid).toBe(true);

    // 11. Sam's dashboard: paid only by PayPal's confirmation, amount = his locked allocation.
    const o = (await getWorkerOverview(db, "w_sam", NOW))!;
    const oct30 = o.shifts.find((x) => x.date === "2026-10-30")!;
    expect(oct30.state).toBe("paid");
    expect(o.totals.paidPence).toBe(oct30.sharePence);
    expect(oct30.payout).toMatchObject({ status: "success", reconciliationIssue: null });
  });

  it("an UNCLAIMED item (recipient isn't a real sandbox account) is shown as Needs review, never Paid", async () => {
    await runDemoSetup(db, { recipientsCsv: RECIPIENTS, query: "none" });
    await saveAllocation(db, DEMO_SHIFT_ID, "demo-manager");
    const fake = createFakePayPal();
    const cfg = loadPayPalConfig(ENV);
    const gateway = paypalGateway(new PayPalClient(cfg, fake.fetchImpl as unknown as typeof fetch), cfg);
    await requestShiftPayout(db, gateway, { shiftId: DEMO_SHIFT_ID, actor: "m", validate: (id, items) => assertPayoutAllowed(cfg, id, items) });
    fake.settle([...fake.batches.keys()][0], "SUCCESS", () => "UNCLAIMED");
    const r = await refreshShiftPayoutStatus(db, gateway, { shiftId: DEMO_SHIFT_ID, actor: "m" });
    expect(r.allPaid).toBe(false);
    const o = (await getWorkerOverview(db, "w_sam", { now: new Date("2026-11-05T12:00:00Z") }))!;
    expect(o.shifts.find((x) => x.date === "2026-10-30")!.state).toBe("needs_review");
    expect(o.totals.paidPence).toBe(0);
  });
});

describe("paypal:preflight (read-only)", () => {
  beforeEach(async () => {
    await runDemoSetup(db, { recipientsCsv: RECIPIENTS });
  });
  const failed = (r: Awaited<ReturnType<typeof runPreflight>>) => r.checks.filter((c) => c.status === "fail").map((c) => c.name);

  it("passes with five allowlisted recipients, sandbox config and amounts within limits — and changes nothing", async () => {
    const c0 = await counts();
    const r = await runPreflight(db, ENV, okProbe);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(5);
    expect(r.checks.filter((c) => c.name.startsWith("Recipient allowlisted"))).toHaveLength(5);
    expect(r.checks.find((c) => c.name.startsWith("PayPal API is the SANDBOX"))!.detail).toContain("api-m.sandbox.paypal.com");
    expect(JSON.stringify(r)).not.toMatch(/demo-only-code-123|sbx-SECRET-value-9f3k|sam-sb@personal/); // no secrets or full emails
    expect(r.manual.join(" ")).toMatch(/PERSONAL/);
    expect(r.manual.join(" ")).toMatch(/balance/);
    expect(await counts()).toEqual(c0);
  });

  it("fails if a worker's email isn't allowlisted (e.g. only four recipients configured)", async () => {
    const r = await runPreflight(db, { ...ENV, PAYPAL_SANDBOX_RECIPIENTS: TEST_RECIPIENTS.slice(0, 4).join(",") }, okProbe);
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(expect.arrayContaining(["Recipient allowlisted: Casey Byrne", "Batch passes the payout guards (dry run — nothing sent)"]));
  });

  it("fails if an amount exceeds the per-item limit, or the batch the batch cap", async () => {
    expect(failed(await runPreflight(db, { ...ENV, PAYOUT_MAX_ITEM_PENCE: "10000" }, okProbe))).toContain("Batch passes the payout guards (dry run — nothing sent)");
    expect(failed(await runPreflight(db, { ...ENV, PAYOUT_MAX_BATCH_PENCE: "40000" }, okProbe))).toContain("Batch passes the payout guards (dry run — nothing sent)");
  });

  it("fails without payouts enabled, with a short approval code, a non-local database, or a non-sandbox PAYPAL_ENV", async () => {
    expect(failed(await runPreflight(db, { ...ENV, PAYOUTS_ENABLED: "false" }, okProbe))).toContain("Payouts enabled in THIS environment only");
    expect(failed(await runPreflight(db, { ...ENV, MANAGER_APPROVAL_CODE: "short" }, okProbe))).toContain("Payouts enabled in THIS environment only");
    expect(failed(await runPreflight(db, { ...ENV, DATABASE_URL: "postgres://u:p@db.x.supabase.co:5432/postgres" }, okProbe))).toContain("Database is local (not Supabase)");
    expect(failed(await runPreflight(db, { ...ENV, PAYPAL_ENV: "live" }, okProbe))).toContain("PayPal configuration loads");
  });

  it("fails if sandbox credentials are rejected or lack the Payouts permission", async () => {
    expect(failed(await runPreflight(db, ENV, async () => Promise.reject(new Error("401"))))).toContain("Sandbox credentials accepted by PayPal sandbox");
    expect(failed(await runPreflight(db, ENV, async () => ({ scopes: [] })))).toContain("Token has the Payouts permission");
  });

  it("fails once a batch exists for the demo shift (never a second batch)", async () => {
    await correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-31T00:30:00Z", reason: "Pay query accepted", actor: "m" });
    await saveAllocation(db, DEMO_SHIFT_ID, "m");
    const fake = createFakePayPal();
    const cfg = loadPayPalConfig(ENV);
    await requestShiftPayout(db, paypalGateway(new PayPalClient(cfg, fake.fetchImpl as unknown as typeof fetch), cfg), { shiftId: DEMO_SHIFT_ID, actor: "m", validate: (id, items) => assertPayoutAllowed(cfg, id, items) });
    expect(failed(await runPreflight(db, ENV, okProbe))).toContain("No payout yet for the demo shift (idempotency)");
  });

  it("shared sandbox accounts (one email repeated) are allowed and reported", async () => {
    const pg2 = new PGlite();
    const db2 = drizzle({ client: pg2, schema: s }) as unknown as Db;
    await migrate(drizzle({ client: pg2 }), { migrationsFolder: "./drizzle" });
    const one = TEST_RECIPIENTS[0];
    await runDemoSetup(db2, { recipientsCsv: Array(5).fill(one).join(",") });
    const r = await runPreflight(db2, { ...ENV, PAYPAL_SANDBOX_RECIPIENTS: one }, okProbe);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "Shared recipient accounts")?.detail).toMatch(/5 workers use 1 distinct/);
    await pg2.close();
  });
});
