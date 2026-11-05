/**
 * npm run demo:setup — prepare the ISOLATED sandbox demo database.
 *
 * Refuses unless DATABASE_URL is a local database (the throwaway Postgres in
 * this Codespace). Applies migrations, seeds synthetic data, corrects Sam's
 * missing 30 Oct clock-out to 23:30 (as on the public site), and creates Sam's
 * "+1 hour" pay query → submitted → accepted by the manager — all through the
 * app's own audited commands. Never calls PayPal. Never creates a payout.
 *
 *   --query=accepted (default) | submitted | none
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../lib/db/schema";
import type { Db } from "../lib/db/connect";
import { assertLocalDatabase, DemoEnvError, runDemoSetup, type DemoQueryState } from "../lib/demo/sandbox";

async function main() {
  const { values } = parseArgs({ options: { query: { type: "string", default: "accepted" } } });
  const query = values.query as DemoQueryState;
  if (!["accepted", "submitted", "none"].includes(query)) throw new DemoEnvError("--query must be accepted, submitted or none");

  const url = process.env.DATABASE_URL;
  assertLocalDatabase(url); // before any connection is opened
  const client = postgres(url!, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
    console.log("✓ Migrations applied to the LOCAL demo database");
    const db = drizzle({ client, schema }) as unknown as Db;
    const r = await runDemoSetup(db, { recipientsCsv: process.env.PAYPAL_SANDBOX_RECIPIENTS, query });
    console.log("✓ Synthetic demo data seeded (no PayPal calls)");
    console.log("✓ Sam's 30 Oct clock-out set to the rota end, 23:30 (audited correction)");
    if (r.query !== "none") console.log(`✓ Sam's "+1 hour" pay query created and ${r.query === "accepted" ? "accepted by the manager" : "sent to the manager"} (no AI summary invented)`);
    console.log("\nNext: npm run paypal:preflight");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${e instanceof DemoEnvError ? e.message : e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/[^\s]+/g, "[database url]") : e}`);
  process.exit(1);
});
