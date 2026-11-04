/**
 * npm run db:status — READ-ONLY check of the database in DATABASE_URL.
 *
 * Shows which database it is (host, port, user — never the password), which
 * committed migrations are applied or pending, columns the app needs that are
 * missing, row counts, and whether the pending migrations would apply cleanly.
 * The connection is opened read-only: this script cannot change anything.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../lib/db/schema";
import type { Db } from "../lib/db/connect";
import { migrationBlockers, schemaStatus } from "../lib/db/status";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const u = new URL(url);
  console.log("Database (compare these with Render's DATABASE_URL — the password is never shown):");
  console.log(`  host: ${u.hostname} · port: ${u.port || "5432"} · user: ${decodeURIComponent(u.username)} · database: ${u.pathname.slice(1) || "postgres"}`);

  const client = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connection: { default_transaction_read_only: true } });
  try {
    const db = drizzle({ client, schema }) as unknown as Db;
    const st = await schemaStatus(db);
    console.log(`\nMigrations applied (${st.applied.length}): ${st.applied.join(", ") || "none"}`);
    console.log(`Migrations pending (${st.pending.length}): ${st.pending.join(", ") || "none"}`);
    if (st.unknownApplied) console.log(`⚠ ${st.unknownApplied} applied migration(s) don't match this repository.`);
    console.log(`\nTables missing: ${st.missingTables.join(", ") || "none"}`);
    console.log(`Columns missing (${st.missingColumns.length}): ${st.missingColumns.map((m) => `${m.table}.${m.column}`).join(", ") || "none"}`);
    console.log(`\nRow counts: ${Object.entries(st.rowCounts).map(([t, n]) => `${t}=${n}`).join(", ")}`);
    if (st.ok) {
      console.log("\nRESULT: ✓ The database matches the app's schema. Nothing to migrate.");
      return;
    }
    const blockers = migrationBlockers(st);
    if (blockers.length) {
      console.log("\nRESULT: ✗ Out of date, and the pending migrations would NOT apply cleanly:");
      for (const b of blockers) console.log(`  - ${b}`);
      console.log("Do not run db-migrate yet — ask for help. (Even if run, it would roll back and change nothing.)");
      process.exitCode = 1;
      return;
    }
    console.log("\nRESULT: ⚠ Out of date. Run the db-migrate task to apply the pending migrations (additive; existing rows are kept).");
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Status check failed:", err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/[^\s]+/g, "[database url]") : err);
  process.exit(1);
});
