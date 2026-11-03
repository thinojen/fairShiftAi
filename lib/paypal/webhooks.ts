/**
 * PayPal webhook verification.
 *
 * STATUS (Milestone 1):
 *   ✓ Signature verification via PayPal's verify-webhook-signature API
 *   ✓ Duplicate-safe event storage (webhook_events keyed by PayPal event id) — in the route
 *   ✗ NOT YET IMPLEMENTED: applying payout item events to the `payouts` table.
 *     Events are stored with processed_at = NULL until Milestone 2 adds that.
 */
import type { PayPalClient } from "./client";

export const PAYOUT_EVENT_TYPES = [
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.HELD",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED",
  "PAYMENT.PAYOUTS-ITEM.CANCELED",
  "PAYMENT.PAYOUTS-ITEM.DENIED",
] as const;

export type WebhookEvent = {
  id: string;
  event_type: string;
  resource?: { payout_item_id?: string; payout_batch_id?: string; batch_header?: { payout_batch_id?: string } } & Record<string, unknown>;
};

const REQUIRED_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

export function readTransmissionHeaders(headers: Headers) {
  const out: Record<(typeof REQUIRED_HEADERS)[number], string> = {} as never;
  for (const h of REQUIRED_HEADERS) {
    const v = headers.get(h);
    if (!v) return null;
    out[h] = v;
  }
  return out;
}

/** Ask PayPal whether this webhook delivery is genuine. */
export async function verifyWebhookSignature(
  client: PayPalClient,
  webhookId: string,
  headers: Headers,
  event: unknown,
): Promise<boolean> {
  const t = readTransmissionHeaders(headers);
  if (!t) return false;
  const res = await client.request<{ verification_status: "SUCCESS" | "FAILURE" }>(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    {
      body: {
        auth_algo: t["paypal-auth-algo"],
        cert_url: t["paypal-cert-url"],
        transmission_id: t["paypal-transmission-id"],
        transmission_sig: t["paypal-transmission-sig"],
        transmission_time: t["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      },
    },
  );
  return res.data.verification_status === "SUCCESS";
}

export function eventResourceId(event: WebhookEvent): string | null {
  const r = event.resource;
  return r?.payout_item_id ?? r?.batch_header?.payout_batch_id ?? r?.payout_batch_id ?? null;
}
