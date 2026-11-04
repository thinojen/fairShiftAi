/**
 * Regression: the live /worker page crashed with Postgres 42703
 * `column "shift_assignment_id" does not exist` because Supabase was still at
 * migration 0003 while the app (Milestone 3) expected 0004.
 *
 * These tests rebuild that state with the REAL migrations (0000–0003 only),
 * reproduce the crash, then apply the remaining migrations with the normal
 * migrator and check the dashboard works and no existing row changed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/connect";
import * as schema from "@/lib/db/schema";
import { seedDemo } from "@/lib/db/seed";
import { migrationBlockers, readJournal, schemaStatus } from "@/lib/db/status";
import { correctAssignmentTime, saveAllocation } from "@/lib/shifts/commands";
import { getWorkerOverview } from "@/lib/worker/queries";
import { TEST_RECIPIENTS } from "./helpers/pglite";

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

/** A migrations folder containing only the first `upto` committed migrations (e.g. production at 0003). */
function migrationsUpTo(upto: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fairshift-mig-"));
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync("./drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < upto);
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries as Array<{ tag: string }>) fs.copyFileSync(`./drizzle/${e.tag}.sql`, path.join(dir, `${e.tag}.sql`));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function dbAt(upto: number) {
  const client = new PGlite();
  cleanup.push(() => client.close());
  const db = drizzle({ client, schema }) as unknown as Db;
  await migrate(drizzle({ client }), { migrationsFolder: migrationsUpTo(upto) });
  return { client, db };
}

/** Every row of every table except pay_queries, for a before/after comparison. */
async function fingerprint(db: Db) {
  const out: Record<string, unknown> = {};
  for (const t of ["venues", "workers", "tip_policies", "shifts", "shift_assignments", "tip_pools", "allocations", "time_corrections", "flags", "audit_log", "payout_batches", "payouts"]) {
    const r = (await db.execute(sql.raw(`select * from "${t}" order by 1`))) as unknown as { rows: unknown[] };
    out[t] = r.rows;
  }
  return JSON.stringify(out);
}

describe("production schema drift (pay_queries.shift_assignment_id)", () => {
  it("a database at 0003 is reported as out of date, with exactly the missing pay_queries columns", async () => {
    const { db } = await dbAt(4); // 0000–0003
    await seedDemo(db, { recipientsCsv: TEST_RECIPIENTS.join(",") });
    const st = await schemaStatus(db);
    expect(st.ok).toBe(false);
    expect(st.applied).toEqual(["0000_init", "0001_milestone2", "0002_payout_safety", "0003_protect_payment_history"]);
    expect(st.pending).toEqual(["0004_pay_queries_workflow"]);
    expect(st.missingTables).toEqual([]);
    expect(st.missingColumns.map((m) => `${m.table}.${m.column}`).sort()).toEqual(
      ["claimed_value", "field", "recorded_value", "reviewed_at", "reviewed_by", "shift_assignment_id", "submitted_at", "updated_at"].map((c) => `pay_queries.${c}`),
    );
    expect(migrationBlockers(st)).toEqual([]);
  });

  it("reproduces the live crash (42703), and the normal migrator fixes it without changing any existing row", async () => {
    const { client, db } = await dbAt(4);
    await seedDemo(db, { recipientsCsv: TEST_RECIPIENTS.join(",") });
    // Manager activity that happened before the upgrade: an audited correction and locked allocations.
    await correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-30T23:30:00Z", reason: "No clock-out recorded; set to rota end", actor: "demo-manager" });
    await saveAllocation(db, "sh_2026-10-23_dinner", "demo-manager");
    await saveAllocation(db, "sh_2026-10-30_dinner", "demo-manager");

    await expect(getWorkerOverview(db, "w_sam")).rejects.toMatchObject({ cause: expect.objectContaining({ code: "42703" }) });
    const before = await fingerprint(db);

    await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });

    const st = await schemaStatus(db);
    expect(st).toMatchObject({ ok: true, pending: [], missingColumns: [] });
    expect(await fingerprint(db)).toBe(before);
    const o = await getWorkerOverview(db, "w_sam");
    expect(JSON.stringify(o)).toContain("15477"); // Sam's 30 Oct share, from the allocation locked before the upgrade
  });

  it("from Milestone 2 (0001) all three pending migrations apply and keep every row", async () => {
    const { client, db } = await dbAt(2);
    await seedDemo(db, { recipientsCsv: TEST_RECIPIENTS.join(",") });
    await correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-30T23:30:00Z", reason: "No clock-out recorded; set to rota end", actor: "demo-manager" });
    await saveAllocation(db, "sh_2026-10-23_dinner", "demo-manager");
    const st0 = await schemaStatus(db);
    expect(st0.rowCounts).toMatchObject({ shift_assignments: 16, time_corrections: 1 });
    expect(st0.rowCounts.allocations).toBeGreaterThan(0);
    expect(st0.pending).toEqual(["0002_payout_safety", "0003_protect_payment_history", "0004_pay_queries_workflow"]);
    const before = await fingerprint(db);
    await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
    expect((await schemaStatus(db)).ok).toBe(true);
    expect(await fingerprint(db)).toBe(before);
  });

  it("if pay_queries already had rows, 0004 is reported as blocked — and a forced run rolls back completely", async () => {
    const { client, db } = await dbAt(4);
    await seedDemo(db, { recipientsCsv: TEST_RECIPIENTS.join(",") });
    await correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-30T23:30:00Z", reason: "No clock-out recorded", actor: "m" });
    await saveAllocation(db, "sh_2026-10-30_dinner", "m");
    await db.execute(sql`insert into pay_queries (id, worker_id, allocation_id, worker_message) select 'pq_old', worker_id, id, 'old-style query' from allocations where worker_id = 'w_sam' limit 1`);

    const st = await schemaStatus(db);
    expect(migrationBlockers(st)).toEqual(["0004 adds pay_queries.shift_assignment_id NOT NULL but pay_queries has 1 row(s)"]);
    const before = await fingerprint(db);
    await expect(migrate(drizzle({ client }), { migrationsFolder: "./drizzle" })).rejects.toThrow();
    // One transaction: nothing half-applied, nothing lost.
    expect((await schemaStatus(db)).pending).toEqual(["0004_pay_queries_workflow"]);
    expect(await fingerprint(db)).toBe(before);
    const r = (await db.execute(sql`select count(*)::int as n from pay_queries`)) as unknown as { rows: Array<{ n: number }> };
    expect(r.rows[0].n).toBe(1);
  });

  it("the committed migrations produce every column the app's schema uses (catches schema edits without a migration)", async () => {
    const { db } = await dbAt(readJournal().length);
    const st = await schemaStatus(db);
    expect(st).toMatchObject({ ok: true, pending: [], missingTables: [], missingColumns: [], unknownApplied: 0 });
  });
});
