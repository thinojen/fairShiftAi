/**
 * npm run paypal:check — READ-ONLY PayPal sandbox feasibility check.
 *
 * Verifies authentication, the Payouts permission, and that the Payouts API is
 * reachable with this app's credentials. It never creates a payout or moves money.
 * Exit code 0 = all required checks passed.
 */
import "dotenv/config";
import { PayPalApiError, PayPalClient } from "../lib/paypal/client";
import {
  loadPayPalConfig,
  maskEmail,
  PAYOUTS_SCOPE,
  WEBHOOKS_SCOPE,
} from "../lib/paypal/config";

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const info = (m: string) => console.log(`  • ${m}`);

async function main() {
  console.log("FairShift — PayPal sandbox check (read-only, no money moves)\n");
  let failed = false;

  const cfg = loadPayPalConfig();
  ok(`Environment: sandbox (${cfg.baseUrl})`);

  // 1. Authentication
  const client = new PayPalClient(cfg);
  const token = await client.getToken();
  ok("Authenticated with client credentials (token not displayed)");
  if (token.appId) info(`App id: ${token.appId.slice(0, 8)}…`);

  // 2. Permissions
  if (token.scopes.includes(PAYOUTS_SCOPE)) {
    ok("Payouts permission is present on this app");
  } else {
    failed = true;
    bad("Payouts permission is MISSING. In the PayPal Developer dashboard, open your sandbox app → Features and enable Payouts.");
  }
  if (token.scopes.includes(WEBHOOKS_SCOPE)) ok("Webhooks permission is present");
  else info("Webhooks scope not listed (only needed for webhook management)");

  // 3. Payouts API reachability — a lookup for a batch that cannot exist.
  //    404 means: authorised and the endpoint is live. 401/403 means: not permitted.
  try {
    await client.request("GET", "/v1/payments/payouts/FAIRSHIFTCONNECTIVITYPROBE");
    info("Probe unexpectedly returned a batch (harmless)");
  } catch (err) {
    if (err instanceof PayPalApiError && (err.status === 404 || err.status === 400)) {
      ok(`Payouts API reachable and authorised (probe → ${err.status} ${err.paypalName ?? ""}, as expected)`);
    } else if (err instanceof PayPalApiError && (err.status === 401 || err.status === 403)) {
      failed = true;
      bad(`Payouts API refused this app (${err.status} ${err.paypalName ?? ""}). debug_id=${err.debugId ?? "n/a"}`);
    } else {
      throw err;
    }
  }

  // 4. Recipient allowlist
  if (cfg.recipientAllowlist.size === 0) {
    failed = true;
    bad("PAYPAL_SANDBOX_RECIPIENTS is empty — payouts will be refused until you add sandbox personal-account emails");
  } else {
    ok(`${cfg.recipientAllowlist.size} allowlisted sandbox recipient(s): ${[...cfg.recipientAllowlist].map(maskEmail).join(", ")}`);
  }
  info(`Payout limits: £${cfg.maxItemPence / 100} per item, £${cfg.maxBatchPence / 100} per batch`);
  info(cfg.webhookId ? "PAYPAL_WEBHOOK_ID is set" : "PAYPAL_WEBHOOK_ID not set yet (needed once the app is deployed)");

  console.log(failed ? "\nRESULT: ✗ Some required checks failed (see above)." : "\nRESULT: ✓ PayPal sandbox is ready for Payouts. No money was moved.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  const debug = err instanceof PayPalApiError && err.debugId ? ` (debug_id=${err.debugId})` : "";
  console.error(`\nRESULT: ✗ Check failed: ${msg}${debug}`);
  process.exit(1);
});
