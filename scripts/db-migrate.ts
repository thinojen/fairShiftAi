/**
 * npm run db:migrate — apply the generated SQL migrations in /drizzle.
 * Use the Supabase *session* pooler (port 5432) or a direct connection for this.
 *
 * Safe by design: Drizzle applies only migrations newer than the last applied
 * one, all inside ONE transaction (any error rolls everything back). Before
 * applying, this script lists what is pending and refuses if existing rows
 * would block a NOT NULL column; afterwards it re-checks every column the app needs.
 * It never drops tables, deletes rows or reseeds.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../lib/db/schema";
import type { Db } from "../lib/db/connect";
import { migrationBlockers, schemaStatus } from "../lib/db/status";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const u = new URL(url);
  console.log(`Database: host ${u.hostname} · port ${u.port || "5432"} · user ${decodeURIComponent(u.username)} (password not shown)`);
  const client = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    const db = drizzle({ client, schema }) as unknown as Db;
    const before = await schemaStatus(db);
    console.log(`Pending migrations: ${before.pending.join(", ") || "none"}`);
    const blockers = migrationBlockers(before);
    if (blockers.length) {
      console.error("✗ Not applying — existing rows would block these migrations:");
      for (const b of blockers) console.error(`  - ${b}`);
      process.exit(1);
    }
    const counts = before.rowCounts;
    await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
    const after = await schemaStatus(db);
    const lost = Object.entries(counts).filter(([t, n]) => (after.rowCounts[t] ?? 0) < n);
    if (!after.ok || lost.length) {
      console.error(`✗ After migrating: pending ${after.pending.join(", ") || "none"}; missing columns ${after.missingColumns.map((m) => `${m.table}.${m.column}`).join(", ") || "none"}; tables with fewer rows ${lost.map(([t]) => t).join(", ") || "none"}`);
      process.exit(1);
    }
    console.log(`✓ Migrations applied. Schema matches the app. Row counts unchanged or higher (${Object.entries(after.rowCounts).map(([t, n]) => `${t}=${n}`).join(", ")}).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed (nothing was applied — it runs in one transaction):", err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/[^\s]+/g, "[database url]") : err);
  process.exit(1);
});
