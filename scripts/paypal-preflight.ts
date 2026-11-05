/**
 * npm run paypal:preflight — READ-ONLY safety checks before the sandbox payout.
 *
 * Never creates a payout and never writes to the database (read-only
 * connection). The only network call is an OAuth token request to the PayPal
 * SANDBOX to prove the credentials are sandbox credentials with the Payouts
 * permission (skip it with --offline). Secrets and full emails are never printed.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../lib/db/schema";
import type { Db } from "../lib/db/connect";
import { assertLocalDatabase, DemoEnvError, runPreflight } from "../lib/demo/sandbox";
import { PayPalClient } from "../lib/paypal/client";

async function main() {
  const { values } = parseArgs({ options: { offline: { type: "boolean", default: false } } });
  const url = process.env.DATABASE_URL;
  assertLocalDatabase(url);
  const client = postgres(url!, { prepare: false, max: 1, onnotice: () => {}, connection: { default_transaction_read_only: true } });
  try {
    const db = drizzle({ client, schema }) as unknown as Db;
    const probe = values.offline ? undefined : async (cfg: ConstructorParameters<typeof PayPalClient>[0]) => ({ scopes: (await new PayPalClient(cfg).getToken()).scopes });
    const r = await runPreflight(db, process.env, probe);

    console.log("FairShift sandbox payout PREFLIGHT (read-only — nothing is sent, nothing is changed)\n");
    console.log("AUTOMATIC CHECKS");
    for (const c of r.checks) console.log(`  ${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "•"} ${c.name}\n      ${c.detail}`);
    if (r.items.length) {
      console.log("\nTHE BATCH “Approve & pay” WOULD SEND (30 Oct dinner; amounts from the tip engine)");
      for (const i of r.items) console.log(`  ${i.worker.padEnd(14)} ${i.email.padEnd(34)} ${i.amount.padStart(9)}`);
      console.log(`  ${"Total".padEnd(49)} £${((r.totalPence ?? 0) / 100).toFixed(2).padStart(8)}`);
    }
    console.log("\nCHECK THESE YOURSELF (FairShift cannot see them)");
    r.manual.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    console.log(r.ok ? "\nRESULT: ✓ All automatic checks passed. Nothing has been paid. Confirm the manual checks above before approving a payout." : "\nRESULT: ✗ Fix the failed checks above before any payout.");
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${e instanceof DemoEnvError ? e.message : e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/[^\s]+/g, "[database url]") : e}`);
  process.exit(1);
});
