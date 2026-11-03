/**
 * Server-side payout guards. These run inside every payout call, independently
 * of the demo role-switcher cookie (which is NOT a security boundary).
 */
import { assertPence } from "../money";
import { MAX_ITEMS_PER_BATCH, maskEmail, type PayPalConfig } from "./config";

export type PayoutItemInput = {
  /** Idempotency key for this item (allocation id or pay query id). */
  senderItemId: string;
  receiverEmail: string;
  amountPence: number;
  note: string;
};

export class PayoutGuardError extends Error {
  name = "PayoutGuardError";
}

export function assertPayoutAllowed(
  cfg: Pick<PayPalConfig, "recipientAllowlist" | "maxItemPence" | "maxBatchPence">,
  senderBatchId: string,
  items: PayoutItemInput[],
): void {
  if (!/^[A-Za-z0-9_-]{8,127}$/.test(senderBatchId)) {
    throw new PayoutGuardError("sender_batch_id must be 8–127 chars of [A-Za-z0-9_-]");
  }
  if (items.length === 0) throw new PayoutGuardError("A payout batch needs at least one item");
  if (items.length > MAX_ITEMS_PER_BATCH) {
    throw new PayoutGuardError(`A payout batch may contain at most ${MAX_ITEMS_PER_BATCH} items`);
  }
  if (cfg.recipientAllowlist.size === 0) {
    throw new PayoutGuardError(
      "No sandbox recipients are allowlisted (PAYPAL_SANDBOX_RECIPIENTS is empty)",
    );
  }

  const seen = new Set<string>();
  let total = 0;
  for (const item of items) {
    assertPence(item.amountPence, `amount for ${item.senderItemId}`);
    if (item.amountPence <= 0) throw new PayoutGuardError("Payout amounts must be positive");
    if (item.amountPence > cfg.maxItemPence) {
      throw new PayoutGuardError(
        `Item ${item.senderItemId} exceeds the per-item limit (${item.amountPence} > ${cfg.maxItemPence} pence)`,
      );
    }
    if (!cfg.recipientAllowlist.has(item.receiverEmail.trim().toLowerCase())) {
      throw new PayoutGuardError(
        `Recipient ${maskEmail(item.receiverEmail)} is not an allowlisted sandbox account`,
      );
    }
    if (seen.has(item.senderItemId)) {
      throw new PayoutGuardError(`Duplicate sender_item_id ${item.senderItemId}`);
    }
    seen.add(item.senderItemId);
    total += item.amountPence;
  }
  if (total > cfg.maxBatchPence) {
    throw new PayoutGuardError(
      `Batch total ${total} pence exceeds the per-batch limit of ${cfg.maxBatchPence} pence`,
    );
  }
}
