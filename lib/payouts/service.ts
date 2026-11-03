/**
 * Transaction-safe shift payouts.
 *
 * A unique index alone can't make an external payment safe, so this runs in
 * three phases:
 *
 *  1. PREPARE + CLAIM (one DB transaction, shift row locked FOR UPDATE)
 *     - first request: re-verify the saved allocation against a fresh engine
 *       run, pre-validate with the PayPal guards, then PERSIST the batch row
 *       with a new sender_batch_id and one payout row per worker
 *     - later requests: reuse the existing batch (same sender_batch_id)
 *     - atomically claim the batch (status → "sending"); a concurrent request
 *       finds it claimed and stops
 *  2. SEND to PayPal outside the transaction, using ONLY the persisted rows,
 *     with sender_batch_id as PayPal-Request-Id (PayPal returns the original
 *     batch on a retry instead of paying again)
 *  3. RECORD the outcome. Uncertain failures leave the batch retryable with the
 *     same id; nothing ever creates a second batch for the shift.
 *
 * A batch that PayPal has accepted is never re-sent. Individual failed or
 * unclaimed items are NOT retried here — that needs a separately authorised
 * correction payout (Milestone 4).
 */
import { randomBytes } from "node:crypto";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import type { Db } from "../db/connect";
import * as s from "../db/schema";
import { decimalStringToPence } from "../money";
import { PayPalApiError } from "../paypal/client";
import { PayoutGuardError, type PayoutItemInput } from "../paypal/guards";
import { mapBatchStatus, mapItemStatus } from "../paypal/payouts";
import { allocateTips } from "../tips/engine";
import { policyForDate } from "../tips/policy";
import { toEngineAssignments } from "../shifts/queries";
import type { PayoutGateway } from "./gateway";

export class PayoutError extends Error {
  name = "PayoutError";
  constructor(
    message: string,
    readonly code: "not_ready" | "stale_allocation" | "nothing_to_pay" | "in_progress" | "already_sent" | "guard" | "not_found",
  ) {
    super(message);
  }
}

/** A "sending" claim older than this is assumed abandoned (e.g. a crashed request). */
export const STALE_CLAIM_MS = 2 * 60_000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type SendOutcome =
  | { kind: "accepted"; batchId: string; senderBatchId: string; paypalBatchId: string; batchStatus: string; attempt: number }
  | { kind: "not_sent" | "rejected" | "uncertain"; batchId: string; senderBatchId: string; message: string; attempt: number };

function newSenderBatchId(shiftId: string) {
  const safe = shiftId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  return `fs_${safe}_${randomBytes(6).toString("hex")}`;
}

async function prepareAndClaim(
  tx: Tx,
  args: { shiftId: string; actor: string; validate: (senderBatchId: string, items: PayoutItemInput[]) => void; now: Date },
) {
  const [shift] = await tx.select().from(s.shifts).where(eq(s.shifts.id, args.shiftId)).for("update");
  if (!shift) throw new PayoutError("Shift not found", "not_found");

  let [batch] = await tx
    .select()
    .from(s.payoutBatches)
    .where(and(eq(s.payoutBatches.shiftId, shift.id), eq(s.payoutBatches.kind, "shift")));

  if (!batch) {
    if (shift.status !== "closed") {
      throw new PayoutError("Save (lock) the allocation before requesting a payout", "not_ready");
    }
    const [pool] = await tx.select().from(s.tipPools).where(eq(s.tipPools.shiftId, shift.id));
    if (!pool) throw new PayoutError("This shift has no tip pool", "not_ready");
    const saved = await tx.select().from(s.allocations).where(eq(s.allocations.tipPoolId, pool.id));
    const policies = await tx.select().from(s.tipPolicies).where(eq(s.tipPolicies.venueId, shift.venueId));
    const policy = policyForDate(policies, shift.date);
    if (!policy) throw new PayoutError("No policy in force for this shift", "not_ready");

    // Re-verify: saved amounts must equal a fresh engine run on current data.
    const rows = await tx.select().from(s.shiftAssignments).where(eq(s.shiftAssignments.shiftId, shift.id));
    const fresh = allocateTips({
      grossPence: pool.grossPence,
      policy: { id: policy.id, version: policy.version, rules: policy.rules },
      assignments: toEngineAssignments(rows.map((r) => ({ ...r, workerName: null, corrections: [] }))),
    });
    const freshByWorker = new Map(fresh.ok ? fresh.workers.map((w) => [w.workerId, w.sharePence]) : []);
    const matches =
      fresh.ok &&
      saved.length === fresh.workers.length &&
      saved.every((a) => a.policyId === policy.id && freshByWorker.get(a.workerId) === a.sharePence);
    if (!matches) {
      throw new PayoutError("The saved allocation no longer matches the shift data. Reopen and save it again.", "stale_allocation");
    }

    const payable = saved.filter((a) => a.sharePence > 0);
    if (!payable.length) throw new PayoutError("Nobody has a share above £0 to pay", "nothing_to_pay");

    const workers = await tx
      .select({ id: s.workers.id, email: s.workers.paypalEmail })
      .from(s.workers)
      .where(inArray(s.workers.id, payable.map((a) => a.workerId)));
    const emailOf = new Map(workers.map((w) => [w.id, w.email]));

    const senderBatchId = newSenderBatchId(shift.id);
    const items: PayoutItemInput[] = payable.map((a) => ({
      senderItemId: a.id,
      receiverEmail: emailOf.get(a.workerId) ?? "",
      amountPence: a.sharePence,
      note: `FairShift tips · ${shift.date} ${shift.service} · policy v${policy.version}`,
    }));

    // Pre-validate with the same guards PayPal sending uses: allowlist,
    // per-item cap and total batch value — BEFORE anything is persisted.
    try {
      args.validate(senderBatchId, items);
    } catch (e) {
      if (e instanceof PayoutGuardError) throw new PayoutError(e.message, "guard");
      throw e;
    }

    [batch] = await tx
      .insert(s.payoutBatches)
      .values({ venueId: shift.venueId, shiftId: shift.id, kind: "shift", senderBatchId, status: "created", approvedBy: args.actor })
      .returning();
    await tx.insert(s.payouts).values(
      payable.map((a, i) => ({
        batchId: batch.id,
        workerId: a.workerId,
        allocationId: a.id,
        amountPence: a.sharePence,
        senderItemId: items[i].senderItemId,
        status: "pending" as const,
      })),
    );
    await tx.insert(s.auditLog).values({
      actor: args.actor,
      action: "payout.batch_created",
      entity: "payout_batch",
      entityId: batch.id,
      data: { shiftId: shift.id, senderBatchId, items: payable.length, totalPence: payable.reduce((n, a) => n + a.sharePence, 0) },
    });
  } else if (!["created", "error", "sending"].includes(batch.status)) {
    throw new PayoutError(`PayPal has already accepted this batch (status ${batch.status}). Use “Refresh status”.`, "already_sent");
  }

  // Atomic claim: only one request can move the batch into "sending".
  const staleBefore = new Date(args.now.getTime() - STALE_CLAIM_MS);
  const [claimed] = await tx
    .update(s.payoutBatches)
    .set({ status: "sending", sendAttempts: batch.sendAttempts + 1, updatedAt: args.now })
    .where(
      and(
        eq(s.payoutBatches.id, batch.id),
        or(
          inArray(s.payoutBatches.status, ["created", "error"]),
          and(eq(s.payoutBatches.status, "sending"), lt(s.payoutBatches.updatedAt, staleBefore)),
        ),
      ),
    )
    .returning();
  if (!claimed) throw new PayoutError("A payout request for this shift is already in progress", "in_progress");

  const payoutRows = await tx.select().from(s.payouts).where(eq(s.payouts.batchId, claimed.id));
  const workers = await tx
    .select({ id: s.workers.id, email: s.workers.paypalEmail })
    .from(s.workers)
    .where(inArray(s.workers.id, payoutRows.map((p) => p.workerId)));
  const emailOf = new Map(workers.map((w) => [w.id, w.email]));
  const items: PayoutItemInput[] = payoutRows.map((p) => ({
    senderItemId: p.senderItemId,
    receiverEmail: emailOf.get(p.workerId) ?? "",
    amountPence: p.amountPence,
    note: `FairShift tips · ${shift.date} ${shift.service}`,
  }));
  return { batch: claimed, items };
}

export async function requestShiftPayout(
  db: Db,
  gateway: PayoutGateway,
  args: {
    shiftId: string;
    actor: string;
    validate: (senderBatchId: string, items: PayoutItemInput[]) => void;
    now?: () => Date;
  },
): Promise<SendOutcome> {
  const now = args.now ?? (() => new Date());
  const { batch, items } = await db.transaction((tx) => prepareAndClaim(tx, { ...args, now: now() }));
  const base = { batchId: batch.id, senderBatchId: batch.senderBatchId, attempt: batch.sendAttempts };

  try {
    const res = await gateway.createBatch(batch.senderBatchId, items);
    await db
      .update(s.payoutBatches)
      .set({ paypalBatchId: res.paypalBatchId, status: mapBatchStatus(res.batchStatus), lastError: null, updatedAt: now() })
      .where(eq(s.payoutBatches.id, batch.id));
    await db.insert(s.auditLog).values({
      actor: args.actor,
      action: "payout.batch_accepted",
      entity: "payout_batch",
      entityId: batch.id,
      data: { paypalBatchId: res.paypalBatchId, batchStatus: res.batchStatus, attempt: batch.sendAttempts },
    });
    return { kind: "accepted", ...base, paypalBatchId: res.paypalBatchId, batchStatus: res.batchStatus };
  } catch (err) {
    let kind: "not_sent" | "rejected" | "uncertain";
    let message: string;
    if (err instanceof PayoutGuardError) {
      kind = "not_sent";
      message = `Not sent: ${err.message}`;
    } else if (err instanceof PayPalApiError && [400, 401, 403, 404, 422].includes(err.status)) {
      kind = "rejected";
      message = `PayPal rejected the request (${err.status}${err.paypalName ? ` ${err.paypalName}` : ""}). debug_id=${err.debugId ?? "n/a"}`;
    } else {
      kind = "uncertain";
      message =
        "Outcome uncertain (network error, timeout or PayPal server error). Retrying re-sends the SAME sender_batch_id, so PayPal will not pay twice.";
    }
    await db
      .update(s.payoutBatches)
      .set({ status: "error", lastError: message, updatedAt: now() })
      .where(eq(s.payoutBatches.id, batch.id));
    await db.insert(s.auditLog).values({
      actor: args.actor,
      action: `payout.batch_${kind}`,
      entity: "payout_batch",
      entityId: batch.id,
      data: { message, attempt: batch.sendAttempts },
    });
    return { kind, ...base, message };
  }
}

/**
 * Reconcile with PayPal's real per-item statuses. Idempotent: mirrors whatever
 * PayPal reports; running it twice changes nothing the second time. A worker is
 * only "paid" when THEIR item reports SUCCESS.
 */
export async function refreshShiftPayoutStatus(db: Db, gateway: PayoutGateway, args: { shiftId: string; actor: string }) {
  const [batch] = await db
    .select()
    .from(s.payoutBatches)
    .where(and(eq(s.payoutBatches.shiftId, args.shiftId), eq(s.payoutBatches.kind, "shift")));
  if (!batch) throw new PayoutError("No payout exists for this shift", "not_found");
  if (!batch.paypalBatchId) {
    throw new PayoutError("PayPal has not accepted this batch yet, so there is no status to fetch", "not_ready");
  }

  const res = await gateway.getBatch(batch.paypalBatchId);
  const rows = await db.select().from(s.payouts).where(eq(s.payouts.batchId, batch.id));
  let changed = 0;

  for (const item of res.items ?? []) {
    const row = rows.find((r) => r.senderItemId === item.payout_item.sender_item_id);
    if (!row) continue; // not ours — ignore rather than guess
    const status = mapItemStatus(item.transaction_status);
    let errorMessage = item.errors?.message ? `${item.errors.name ?? ""} ${item.errors.message}`.trim() : null;
    if (decimalStringToPence(item.payout_item.amount.value) !== row.amountPence) {
      errorMessage = `Amount mismatch: PayPal reports ${item.payout_item.amount.value}, expected ${row.amountPence}p`;
    }
    const next = {
      status,
      paypalItemId: item.payout_item_id,
      paypalTransactionId: item.transaction_id ?? null,
      errorMessage,
    };
    const same =
      row.status === next.status &&
      row.paypalItemId === next.paypalItemId &&
      row.paypalTransactionId === next.paypalTransactionId &&
      row.errorMessage === next.errorMessage;
    if (same) continue;
    await db.update(s.payouts).set({ ...next, updatedAt: new Date() }).where(eq(s.payouts.id, row.id));
    changed++;
  }

  const batchStatus = mapBatchStatus(res.batch_header.batch_status);
  await db
    .update(s.payoutBatches)
    .set({ status: batchStatus, lastStatusCheckAt: new Date(), updatedAt: new Date() })
    .where(eq(s.payoutBatches.id, batch.id));

  const after = await db.select().from(s.payouts).where(eq(s.payouts.batchId, batch.id));
  const allPaid = after.length > 0 && after.every((p) => p.status === "success");
  await db.update(s.shifts).set({ status: allPaid ? "paid" : "closed" }).where(eq(s.shifts.id, args.shiftId));

  if (changed) {
    await db.insert(s.auditLog).values({
      actor: args.actor,
      action: "payout.status_refreshed",
      entity: "payout_batch",
      entityId: batch.id,
      data: { batchStatus: res.batch_header.batch_status, changedItems: changed },
    });
  }
  return { batchStatus, changed, allPaid, items: after };
}
