/**
 * PayPal Payouts v1.
 *
 * Important: a batch being ACCEPTED or even reaching batch_status SUCCESS does
 * not mean every recipient was paid. Always read and store per-item
 * transaction_status (see mapItemStatus).
 */
import { CURRENCY, decimalStringToPence, penceToDecimalString } from "../money";
import type { PayPalClient } from "./client";
import type { PayPalConfig } from "./config";
import { assertPayoutAllowed, type PayoutItemInput } from "./guards";

export type { PayoutItemInput };

export type PayoutBatchRequest = {
  sender_batch_header: {
    sender_batch_id: string;
    email_subject: string;
    email_message: string;
  };
  items: Array<{
    recipient_type: "EMAIL";
    amount: { value: string; currency: typeof CURRENCY };
    receiver: string;
    note: string;
    sender_item_id: string;
  }>;
};

export type PayPalBatchStatus = "DENIED" | "PENDING" | "PROCESSING" | "SUCCESS" | "CANCELED";
export type PayPalItemStatus =
  | "SUCCESS"
  | "FAILED"
  | "PENDING"
  | "UNCLAIMED"
  | "RETURNED"
  | "ONHOLD"
  | "BLOCKED"
  | "REFUNDED"
  | "REVERSED";

export type CreatePayoutResponse = {
  batch_header: { payout_batch_id: string; batch_status: PayPalBatchStatus; sender_batch_header: { sender_batch_id: string } };
};

export type PayoutItemDetails = {
  payout_item_id: string;
  transaction_id?: string;
  transaction_status: PayPalItemStatus;
  payout_item: { sender_item_id: string; receiver: string; amount: { value: string; currency: string } };
  errors?: { name?: string; message?: string };
};

export type GetPayoutBatchResponse = {
  batch_header: {
    payout_batch_id: string;
    batch_status: PayPalBatchStatus;
    sender_batch_header: { sender_batch_id: string };
  };
  items?: PayoutItemDetails[];
};

export function buildPayoutBatchRequest(
  senderBatchId: string,
  items: PayoutItemInput[],
): PayoutBatchRequest {
  return {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: "Your FairShift tips (sandbox demo)",
      email_message: "Your share of the tip pool has been sent. This is a PayPal sandbox demo.",
    },
    items: items.map((i) => ({
      recipient_type: "EMAIL",
      amount: { value: penceToDecimalString(i.amountPence), currency: CURRENCY },
      receiver: i.receiverEmail.trim(),
      note: i.note,
      sender_item_id: i.senderItemId,
    })),
  };
}

/**
 * Create a payout batch. Guards run first, every time. The sender_batch_id is
 * also sent as PayPal-Request-Id, so retrying with the SAME id returns the
 * original batch instead of paying twice.
 */
export async function createPayoutBatch(
  client: PayPalClient,
  cfg: Pick<PayPalConfig, "recipientAllowlist" | "maxItemPence" | "maxBatchPence">,
  senderBatchId: string,
  items: PayoutItemInput[],
) {
  assertPayoutAllowed(cfg, senderBatchId, items);
  return client.request<CreatePayoutResponse>("POST", "/v1/payments/payouts", {
    body: buildPayoutBatchRequest(senderBatchId, items),
    requestId: senderBatchId,
  });
}

export async function getPayoutBatch(client: PayPalClient, payoutBatchId: string) {
  return client.request<GetPayoutBatchResponse>(
    "GET",
    `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`,
  );
}

export async function getPayoutItem(client: PayPalClient, payoutItemId: string) {
  return client.request<PayoutItemDetails>(
    "GET",
    `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}`,
  );
}

/** PayPal item status → our payout_status enum. Unknown values are NOT treated as success. */
export function mapItemStatus(status: string) {
  const s = status.toLowerCase();
  const known = [
    "pending",
    "success",
    "failed",
    "unclaimed",
    "returned",
    "onhold",
    "blocked",
    "refunded",
    "reversed",
  ] as const;
  return (known as readonly string[]).includes(s) ? (s as (typeof known)[number]) : "pending";
}

export function mapBatchStatus(status: string) {
  switch (status) {
    case "PENDING":
      return "pending" as const;
    case "PROCESSING":
      return "processing" as const;
    case "SUCCESS":
      return "success" as const;
    case "DENIED":
      return "denied" as const;
    case "CANCELED":
      return "canceled" as const;
    default:
      return "pending" as const;
  }
}

/** True when PayPal has finished processing the batch (items may still differ). */
export function isBatchSettled(status: string) {
  return ["SUCCESS", "DENIED", "CANCELED"].includes(status);
}

export function itemAmountPence(item: PayoutItemDetails): number {
  return decimalStringToPence(item.payout_item.amount.value);
}
