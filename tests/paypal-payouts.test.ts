import { describe, expect, it, vi } from "vitest";
import { PayPalClient } from "@/lib/paypal/client";
import { loadPayPalConfig } from "@/lib/paypal/config";
import { assertPayoutAllowed, PayoutGuardError } from "@/lib/paypal/guards";
import {
  buildPayoutBatchRequest,
  createPayoutBatch,
  isBatchSettled,
  mapItemStatus,
} from "@/lib/paypal/payouts";

const cfg = loadPayPalConfig({
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_SANDBOX_RECIPIENTS: "sam@personal.example.com,priya@personal.example.com",
});
const item = (over = {}) => ({
  senderItemId: "alloc_1",
  receiverEmail: "sam@personal.example.com",
  amountPence: 4210,
  note: "Tips",
  ...over,
});
const BATCH = "fairshift-batch-0001";

describe("payout guards", () => {
  it("accepts a valid allowlisted batch", () => {
    expect(() => assertPayoutAllowed(cfg, BATCH, [item()])).not.toThrow();
  });
  it("rejects recipients outside the sandbox allowlist", () => {
    expect(() => assertPayoutAllowed(cfg, BATCH, [item({ receiverEmail: "x@gmail.com" })])).toThrow(PayoutGuardError);
  });
  it("rejects non-integer, zero, negative and over-limit amounts", () => {
    expect(() => assertPayoutAllowed(cfg, BATCH, [item({ amountPence: 10.5 })])).toThrow();
    expect(() => assertPayoutAllowed(cfg, BATCH, [item({ amountPence: 0 })])).toThrow();
    expect(() => assertPayoutAllowed(cfg, BATCH, [item({ amountPence: -1 })])).toThrow();
    expect(() => assertPayoutAllowed(cfg, BATCH, [item({ amountPence: 20_001 })])).toThrow(/per-item/);
  });
  it("rejects duplicate item ids and over-limit batch totals", () => {
    expect(() => assertPayoutAllowed(cfg, BATCH, [item(), item()])).toThrow(/Duplicate/);
    const many = Array.from({ length: 6 }, (_, i) => item({ senderItemId: `a${i}`, amountPence: 20_000 }));
    expect(() => assertPayoutAllowed(cfg, BATCH, many)).toThrow(/per-batch/);
  });
  it("rejects malformed batch ids and empty batches", () => {
    expect(() => assertPayoutAllowed(cfg, "short", [item()])).toThrow();
    expect(() => assertPayoutAllowed(cfg, BATCH, [])).toThrow();
  });
});

describe("payout requests", () => {
  it("builds a GBP request with string amounts and stable ids", () => {
    const req = buildPayoutBatchRequest(BATCH, [item()]);
    expect(req.sender_batch_header.sender_batch_id).toBe(BATCH);
    expect(req.items[0]).toMatchObject({
      amount: { value: "42.10", currency: "GBP" },
      sender_item_id: "alloc_1",
      recipient_type: "EMAIL",
    });
  });

  it("sends sender_batch_id as PayPal-Request-Id (idempotent retries)", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/oauth2/token")) {
        return Response.json({ access_token: "tok", expires_in: 3600, scope: "" });
      }
      expect((init?.headers as Record<string, string>)["PayPal-Request-Id"]).toBe(BATCH);
      return Response.json(
        { batch_header: { payout_batch_id: "PB1", batch_status: "PENDING", sender_batch_header: { sender_batch_id: BATCH } } },
        { status: 201 },
      );
    });
    const client = new PayPalClient(cfg, fetchMock as unknown as typeof fetch);
    const res = await createPayoutBatch(client, cfg, BATCH, [item()]);
    expect(res.data.batch_header.payout_batch_id).toBe("PB1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never calls PayPal when a guard fails", async () => {
    const fetchMock = vi.fn();
    const client = new PayPalClient(cfg, fetchMock as unknown as typeof fetch);
    await expect(createPayoutBatch(client, cfg, BATCH, [item({ receiverEmail: "x@y.com" })])).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches the OAuth token", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/v1/oauth2/token")
        ? Response.json({ access_token: "tok", expires_in: 3600, scope: "a b" })
        : Response.json({}),
    );
    const client = new PayPalClient(cfg, fetchMock as unknown as typeof fetch);
    await client.request("GET", "/x");
    await client.request("GET", "/y");
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
  });
});

describe("status mapping", () => {
  it("maps item statuses and never treats unknown as success", () => {
    expect(mapItemStatus("SUCCESS")).toBe("success");
    expect(mapItemStatus("UNCLAIMED")).toBe("unclaimed");
    expect(mapItemStatus("SOMETHING_NEW")).toBe("pending");
  });
  it("knows when a batch has finished processing", () => {
    expect(isBatchSettled("SUCCESS")).toBe(true);
    expect(isBatchSettled("PROCESSING")).toBe(false);
  });
});
