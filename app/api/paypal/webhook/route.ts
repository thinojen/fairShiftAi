/**
 * POST /api/paypal/webhook
 *
 * Milestone 1 status:
 *   ✓ Verifies every delivery with PayPal before trusting it (unverified → 400, not stored)
 *   ✓ Stores verified events once, keyed by PayPal's event id (duplicates are ignored)
 *   ✗ INCOMPLETE: does not yet update `payouts` rows from item events.
 *     Stored events keep processed_at = NULL until Milestone 2 implements that.
 */
import { getDb } from "@/lib/db/client";
import { webhookEvents } from "@/lib/db/schema";
import { eventResourceId, getPayPal, verifyWebhookSignature, type WebhookEvent } from "@/lib/paypal/server";

export async function POST(request: Request) {
  let paypal: ReturnType<typeof getPayPal>;
  try {
    paypal = getPayPal();
  } catch {
    return Response.json({ error: "PayPal is not configured" }, { status: 503 });
  }
  if (!paypal.cfg.webhookId) {
    return Response.json({ error: "PAYPAL_WEBHOOK_ID is not configured" }, { status: 503 });
  }

  let event: WebhookEvent;
  try {
    event = (await request.json()) as WebhookEvent;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!event?.id || !event?.event_type) {
    return Response.json({ error: "Not a PayPal event" }, { status: 400 });
  }

  let verified = false;
  try {
    verified = await verifyWebhookSignature(paypal.client, paypal.cfg.webhookId, request.headers, event);
  } catch {
    // PayPal unreachable or rejected the check: ask PayPal to retry later.
    return Response.json({ error: "Verification unavailable" }, { status: 503 });
  }
  if (!verified) {
    return Response.json({ error: "Signature verification failed" }, { status: 400 });
  }

  // Duplicate-safe: PayPal redelivers events; the event id is the primary key.
  await getDb()
    .insert(webhookEvents)
    .values({
      id: event.id,
      eventType: event.event_type,
      resourceId: eventResourceId(event),
      verified: true,
      payload: event,
    })
    .onConflictDoNothing({ target: webhookEvents.id });

  // TODO(Milestone 2): apply payout item status to `payouts` and set processed_at.
  return Response.json({ received: true });
}
