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
  checkScope,
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

  // 2. Permissions — decided ONLY by the scopes on the OAuth token.
  info(`Token carries ${token.scopes.length} scope(s)`);
  const payouts = checkScope(token.scopes, PAYOUTS_SCOPE);
  if (payouts.present) {
    ok(`Payouts permission present (token includes ${PAYOUTS_SCOPE})`);
  } else {
    failed = true;
    bad(`Payouts permission MISSING: token does not include ${PAYOUTS_SCOPE}`);
    if (payouts.relatedScopes.length) {
      info(`Payout-related scopes found instead: ${payouts.relatedScopes.join(", ")}`);
    }
  }
  if (checkScope(token.scopes, WEBHOOKS_SCOPE).present) ok("Webhooks permission present");
  else info("Webhooks scope not listed (only needed for webhook management)");

  // 3. Payouts API connectivity — a read-only lookup of a batch that cannot exist.
  //    This only shows the endpoint is reachable with this token. It is NOT proof
  //    that the app may CREATE payouts — that is decided by the scope check above,
  //    and finally proven only by a successful sandbox test payout.
  try {
    await client.request("GET", "/v1/payments/payouts/FAIRSHIFTCONNECTIVITYPROBE");
    info("Connectivity probe unexpectedly returned a batch (harmless)");
  } catch (err) {
    if (err instanceof PayPalApiError && (err.status === 404 || err.status === 400)) {
      ok(`Payouts API reachable (read-only probe → ${err.status} ${err.paypalName ?? ""}; does not prove write permission)`);
    } else if (err instanceof PayPalApiError && (err.status === 401 || err.status === 403)) {
      failed = true;
      bad(`Payouts API refused this token (${err.status} ${err.paypalName ?? ""}). debug_id=${err.debugId ?? "n/a"}`);
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

  console.log(failed ? "\nRESULT: ✗ Some required checks failed (see above)." : "\nRESULT: ✓ All read-only checks passed. No money was moved.\n" +
          "        Payouts are only proven once `paypal-test-payout` succeeds.");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  const debug = err instanceof PayPalApiError && err.debugId ? ` (debug_id=${err.debugId})` : "";
  console.error(`\nRESULT: ✗ Check failed: ${msg}${debug}`);
  process.exit(1);
});
