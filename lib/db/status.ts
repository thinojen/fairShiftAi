/**
 * Read-only schema status: which committed migrations a database has applied,
 * which are pending, and which columns the app expects but the database lacks.
 * Used by `npm run db:status` (production check) and by tests. Never writes.
 */
import fs from "node:fs";
import path from "node:path";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./connect";
import * as schema from "./schema";

type JournalEntry = { idx: number; when: number; tag: string };

export function readJournal(migrationsFolder = "./drizzle"): JournalEntry[] {
  const j = JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  return j.entries;
}

/** Every table the app's Drizzle schema defines, with its column names. */
export function expectedColumns(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const v of Object.values(schema)) {
    if (is(v, PgTable)) {
      const cfg = getTableConfig(v);
      out[cfg.name] = cfg.columns.map((c) => c.name);
    }
  }
  return out;
}

export type SchemaStatus = {
  applied: string[];
  pending: string[];
  /** Applied rows that don't match any committed migration (should be empty). */
  unknownApplied: number;
  missingTables: string[];
  missingColumns: Array<{ table: string; column: string }>;
  rowCounts: Record<string, number>;
  ok: boolean;
};

export async function schemaStatus(db: Db, migrationsFolder = "./drizzle"): Promise<SchemaStatus> {
  const journal = readJournal(migrationsFolder);

  let appliedAt: number[] = [];
  const hasTable = (await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as ok`)) as unknown as Array<{ ok: boolean }> | { rows: Array<{ ok: boolean }> };
  const exists = (Array.isArray(hasTable) ? hasTable : hasTable.rows)[0]?.ok;
  if (exists) {
    const r = (await db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at`)) as unknown as Array<{ created_at: string | number }> | { rows: Array<{ created_at: string | number }> };
    appliedAt = (Array.isArray(r) ? r : r.rows).map((x) => Number(x.created_at));
  }
  // Drizzle applies a migration when its timestamp is newer than the newest applied one.
  const newest = appliedAt.length ? Math.max(...appliedAt) : -1;
  const applied = journal.filter((e) => e.when <= newest).map((e) => e.tag);
  const pending = journal.filter((e) => e.when > newest).map((e) => e.tag);
  const unknownApplied = appliedAt.filter((t) => !journal.some((e) => e.when === t)).length;

  const colsRes = (await db.execute(
    sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  )) as unknown as Array<{ table_name: string; column_name: string }> | { rows: Array<{ table_name: string; column_name: string }> };
  const actual = new Map<string, Set<string>>();
  for (const r of Array.isArray(colsRes) ? colsRes : colsRes.rows) {
    if (!actual.has(r.table_name)) actual.set(r.table_name, new Set());
    actual.get(r.table_name)!.add(r.column_name);
  }

  const missingTables: string[] = [];
  const missingColumns: Array<{ table: string; column: string }> = [];
  const rowCounts: Record<string, number> = {};
  for (const [table, cols] of Object.entries(expectedColumns())) {
    const have = actual.get(table);
    if (!have) {
      missingTables.push(table);
      continue;
    }
    for (const c of cols) if (!have.has(c)) missingColumns.push({ table, column: c });
    const n = (await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`)) as unknown as Array<{ n: number }> | { rows: Array<{ n: number }> };
    rowCounts[table] = Number((Array.isArray(n) ? n : n.rows)[0]?.n ?? 0);
  }

  return { applied, pending, unknownApplied, missingTables, missingColumns, rowCounts, ok: !pending.length && !missingTables.length && !missingColumns.length && !unknownApplied };
}

/**
 * Would the pending migrations succeed on this data? 0002 and 0004 add NOT NULL
 * columns without defaults, which Postgres refuses on non-empty tables. (If they
 * did fail, the whole run is rolled back — nothing is half-applied.)
 */
export function migrationBlockers(st: SchemaStatus): string[] {
  const out: string[] = [];
  if (st.pending.includes("0002_payout_safety") && (st.rowCounts.payouts ?? 0) > 0) out.push(`0002 adds payouts.receiver_email NOT NULL but payouts has ${st.rowCounts.payouts} row(s)`);
  if (st.pending.includes("0004_pay_queries_workflow") && (st.rowCounts.pay_queries ?? 0) > 0) out.push(`0004 adds pay_queries.shift_assignment_id NOT NULL but pay_queries has ${st.rowCounts.pay_queries} row(s)`);
  return out;
}
