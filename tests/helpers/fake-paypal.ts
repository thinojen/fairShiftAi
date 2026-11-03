/**
 * A fake PayPal HTTP API for tests. Plugged in as the `fetch` of the REAL
 * PayPalClient, so the real guards, request building and idempotency headers
 * all run. Implements PayPal-Request-Id idempotency like the real API.
 */
import { vi } from "vitest";

type Item = { sender_item_id: string; receiver: string; amount: { value: string; currency: string } };

export function createFakePayPal() {
  const batches = new Map<string, { id: string; senderBatchId: string; items: Item[]; status: string; itemStatus: Record<string, string> }>();
  const byRequestId = new Map<string, string>();
  let failNextCreate: "network" | "500" | "422" | null = null;
  let createCalls = 0;
  const tampers = new Map<string, (res: Record<string, any>) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.endsWith("/v1/oauth2/token")) {
      return Response.json({ access_token: "tok", expires_in: 3600, scope: "https://uri.paypal.com/payments/payouts" });
    }
    if (method === "POST" && u.endsWith("/v1/payments/payouts")) {
      createCalls++;
      const reqId = (init?.headers as Record<string, string>)["PayPal-Request-Id"];
      const body = JSON.parse(String(init?.body));
      if (failNextCreate) {
        const f = failNextCreate;
        failNextCreate = null;
        if (f === "network") {
          // Simulate: PayPal received and created the batch, but the response was lost.
          const id = `PB${batches.size + 1}`;
          batches.set(id, { id, senderBatchId: body.sender_batch_header.sender_batch_id, items: body.items, status: "PENDING", itemStatus: {} });
          byRequestId.set(reqId, id);
          throw new TypeError("fetch failed");
        }
        if (f === "500") return Response.json({ name: "INTERNAL_SERVICE_ERROR", message: "boom" }, { status: 500 });
        return Response.json({ name: "VALIDATION_ERROR", message: "bad" }, { status: 422, headers: { "paypal-debug-id": "dbg1" } });
      }
      const existing = reqId && byRequestId.get(reqId);
      const id = existing || `PB${batches.size + 1}`;
      if (!existing) {
        batches.set(id, { id, senderBatchId: body.sender_batch_header.sender_batch_id, items: body.items, status: "PENDING", itemStatus: {} });
        if (reqId) byRequestId.set(reqId, id);
      }
      const b = batches.get(id)!;
      return Response.json(
        { batch_header: { payout_batch_id: id, batch_status: b.status, sender_batch_header: { sender_batch_id: b.senderBatchId } } },
        { status: 201 },
      );
    }
    const m = /\/v1\/payments\/payouts\/([^/?]+)$/.exec(u);
    if (method === "GET" && m) {
      const b = batches.get(decodeURIComponent(m[1]));
      if (!b) return Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
      const body = {
        batch_header: { payout_batch_id: b.id, batch_status: b.status, sender_batch_header: { sender_batch_id: b.senderBatchId } },
        items: b.items.map((it, i) => ({
          payout_item_id: `${b.id}-I${i}`,
          transaction_id: (b.itemStatus[it.sender_item_id] ?? "PENDING") === "SUCCESS" ? `TX${i}` : undefined,
          transaction_status: b.itemStatus[it.sender_item_id] ?? "PENDING",
          payout_item: structuredClone(it),
        })),
      };
      tampers.get(b.id)?.(body);
      return Response.json(body);
    }
    return Response.json({ name: "NOT_IMPLEMENTED", message: u }, { status: 501 });
  });

  return {
    fetchImpl,
    batches,
    get createCalls() {
      return createCalls;
    },
    failNextCreate(kind: "network" | "500" | "422") {
      failNextCreate = kind;
    },
    /** Make PayPal's GET response for a batch disagree with our records (for tests). */
    tamper(batchId: string, fn: (res: Record<string, any>) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
      tampers.set(batchId, fn);
    },
    /** Set PayPal-side statuses: batch status + per-item status keyed by sender_item_id. */
    settle(batchId: string, batchStatus: string, items: Record<string, string> | ((senderItemId: string) => string)) {
      const b = batches.get(batchId)!;
      b.status = batchStatus;
      for (const it of b.items) {
        b.itemStatus[it.sender_item_id] = typeof items === "function" ? items(it.sender_item_id) : (items[it.sender_item_id] ?? "PENDING");
      }
    },
  };
}
