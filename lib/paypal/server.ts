/**
 * The ONLY PayPal entry point app code (app/, components/) may import.
 * `server-only` makes the build fail if this is ever pulled into a client bundle,
 * so credentials can't leak to the browser.
 */
import "server-only";
import { PayPalClient } from "./client";
import { loadPayPalConfig, type PayPalConfig } from "./config";

let cached: { cfg: PayPalConfig; client: PayPalClient } | undefined;

export function getPayPal() {
  if (!cached) {
    const cfg = loadPayPalConfig();
    cached = { cfg, client: new PayPalClient(cfg) };
  }
  return cached;
}

export * from "./payouts";
export { verifyWebhookSignature, eventResourceId, type WebhookEvent } from "./webhooks";
export { PayPalApiError } from "./client";
export { PayoutGuardError, assertPayoutAllowed } from "./guards";
