/**
 * Thin adapter between the payout service and the verified Milestone 1 PayPal
 * client. It adds no payment logic of its own: createPayoutBatch still runs
 * assertPayoutAllowed (allowlist, per-item and per-batch caps) on every call.
 */
import type { PayPalClient } from "../paypal/client";
import type { PayPalConfig } from "../paypal/config";
import {
  createPayoutBatch,
  getPayoutBatch,
  type GetPayoutBatchResponse,
  type PayoutItemInput,
} from "../paypal/payouts";

export type PayoutGateway = {
  createBatch(senderBatchId: string, items: PayoutItemInput[]): Promise<{ paypalBatchId: string; batchStatus: string }>;
  getBatch(paypalBatchId: string): Promise<GetPayoutBatchResponse>;
};

export function paypalGateway(client: PayPalClient, cfg: PayPalConfig): PayoutGateway {
  return {
    async createBatch(senderBatchId, items) {
      const res = await createPayoutBatch(client, cfg, senderBatchId, items);
      return {
        paypalBatchId: res.data.batch_header.payout_batch_id,
        batchStatus: res.data.batch_header.batch_status,
      };
    },
    async getBatch(paypalBatchId) {
      return (await getPayoutBatch(client, paypalBatchId)).data;
    },
  };
}
