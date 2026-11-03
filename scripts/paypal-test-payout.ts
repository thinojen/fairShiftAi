/**
 * npm run paypal:test-payout -- --confirm [--to <sandbox email>] [--batch-id <id>]
 *
 * Sends ONE £1.00 payout in the PayPal SANDBOX to an allowlisted sandbox account,
 * then reports the real batch and item status from PayPal.
 *
 * Safety
 * - Does nothing without --confirm (prints a dry-run summary and exits 1).
 * - Sandbox only; recipient must be in PAYPAL_SANDBOX_RECIPIENTS.
 * - Each new run gets a unique sender_batch_id, printed BEFORE sending.
 *   To retry after a timeout/error, pass that same id via --batch-id:
 *   PayPal returns the original batch instead of paying again.
 * - Never runs automatically (not wired to install, build, test or app start).
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { formatGBP } from "../lib/money";
import { PayPalApiError, PayPalClient } from "../lib/paypal/client";
import { loadPayPalConfig, maskEmail } from "../lib/paypal/config";
import {
  createPayoutBatch,
  getPayoutBatch,
  isBatchSettled,
  type GetPayoutBatchResponse,
} from "../lib/paypal/payouts";

const AMOUNT_PENCE = 100; // £1.00 — fixed

function newSenderBatchId() {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `fairshift-test-${ts}-${randomBytes(3).toString("hex")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { values } = parseArgs({
    options: {
      confirm: { type: "boolean", default: false },
      to: { type: "string" },
      "batch-id": { type: "string" },
    },
  });

  const cfg = loadPayPalConfig();
  const recipient = values.to?.trim() || [...cfg.recipientAllowlist][0];
  if (!recipient) throw new Error("No recipient: set PAYPAL_SANDBOX_RECIPIENTS or pass --to");

  const isRetry = Boolean(values["batch-id"]?.trim());
  const senderBatchId = values["batch-id"]?.trim() || newSenderBatchId();

  console.log("FairShift — PayPal SANDBOX test payout\n");
  console.log(`  Amount:          ${formatGBP(AMOUNT_PENCE)} (sandbox — not real money)`);
  console.log(`  Recipient:       ${maskEmail(recipient)}`);
  console.log(`  sender_batch_id: ${senderBatchId}${isRetry ? "  (RETRY — PayPal will return the original batch, not pay twice)" : ""}`);

  if (!values.confirm) {
    console.log("\nDRY RUN: nothing was sent. Re-run with --confirm to send this sandbox payout.");
    process.exit(1);
  }
  console.log(`\n  ⚠ Save the sender_batch_id above. If this run times out, retry with --batch-id ${senderBatchId}\n`);

  const client = new PayPalClient(cfg);
  const created = await createPayoutBatch(client, cfg, senderBatchId, [
    {
      senderItemId: `${senderBatchId}-1`.slice(0, 63),
      receiverEmail: recipient,
      amountPence: AMOUNT_PENCE,
      note: "FairShift sandbox connectivity test",
    },
  ]);
  const batchId = created.data.batch_header.payout_batch_id;
  console.log(`  ✓ PayPal ACCEPTED the batch (HTTP ${created.status}). payout_batch_id=${batchId}`);
  console.log("    Accepted ≠ paid. Checking the individual item status…\n");

  let batch: GetPayoutBatchResponse | undefined;
  for (let attempt = 1; attempt <= 8; attempt++) {
    batch = (await getPayoutBatch(client, batchId)).data;
    const status = batch.batch_header.batch_status;
    console.log(`  • attempt ${attempt}: batch_status=${status}`);
    if (isBatchSettled(status)) break;
    await sleep(5000);
  }
  if (!batch) throw new Error("Could not read batch status");

  const item = batch.items?.[0];
  console.log(`\n  Batch:  ${batch.batch_header.batch_status}`);
  if (!item) {
    console.log("  Item:   not yet visible — check again later with the same batch id.");
    console.log("\nRESULT: ⚠ Batch accepted, item status UNKNOWN. Do not treat this as paid.");
    process.exit(2);
  }
  console.log(`  Item:   ${item.transaction_status}  (payout_item_id=${item.payout_item_id}${item.transaction_id ? `, transaction_id=${item.transaction_id}` : ""})`);
  if (item.errors?.message) console.log(`  Error:  ${item.errors.name ?? ""} ${item.errors.message}`);

  switch (item.transaction_status) {
    case "SUCCESS":
      console.log("\nRESULT: ✓ Real PayPal SANDBOX payout succeeded for this recipient.");
      process.exit(0);
    case "UNCLAIMED":
      console.log("\nRESULT: ⚠ UNCLAIMED — the email is not a PayPal sandbox account. Use a sandbox personal account email from the Developer dashboard.");
      process.exit(2);
    case "PENDING":
    case "ONHOLD":
      console.log(`\nRESULT: ⚠ ${item.transaction_status} — not paid yet. Re-check later; do not treat this as paid.`);
      process.exit(2);
    default:
      console.log(`\nRESULT: ✗ Payout item ${item.transaction_status}.`);
      process.exit(1);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  const debug = err instanceof PayPalApiError && err.debugId ? ` (debug_id=${err.debugId})` : "";
  console.error(`\nRESULT: ✗ Test payout failed: ${msg}${debug}`);
  console.error("If PayPal may have received the request, retry with the SAME --batch-id shown above.");
  process.exit(1);
});
