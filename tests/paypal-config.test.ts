import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_MAX_ITEM_PENCE,
  loadPayPalConfig,
  maskEmail,
  PAYPAL_SANDBOX_BASE_URL,
} from "@/lib/paypal/config";

const base = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };

describe("PayPal config", () => {
  it("always targets the sandbox", () => {
    expect(loadPayPalConfig(base).baseUrl).toBe(PAYPAL_SANDBOX_BASE_URL);
    expect(PAYPAL_SANDBOX_BASE_URL).toContain("sandbox");
  });

  it("refuses any non-sandbox environment", () => {
    expect(() => loadPayPalConfig({ ...base, PAYPAL_ENV: "live" })).toThrow(/sandbox/);
    expect(() => loadPayPalConfig({ ...base, PAYPAL_ENV: "production" })).toThrow();
  });

  it("ignores attempts to override the base URL", () => {
    const cfg = loadPayPalConfig({ ...base, PAYPAL_BASE_URL: "https://api-m.paypal.com" });
    expect(cfg.baseUrl).toBe(PAYPAL_SANDBOX_BASE_URL);
  });

  it("requires credentials", () => {
    expect(() => loadPayPalConfig({})).toThrow(/PAYPAL_CLIENT_ID/);
  });

  it("parses the recipient allowlist case-insensitively", () => {
    const cfg = loadPayPalConfig({ ...base, PAYPAL_SANDBOX_RECIPIENTS: " A@x.com, b@x.com ,," });
    expect([...cfg.recipientAllowlist]).toEqual(["a@x.com", "b@x.com"]);
  });

  it("caps payout limits at hard ceilings", () => {
    const cfg = loadPayPalConfig({ ...base, PAYOUT_MAX_ITEM_PENCE: "99999999" });
    expect(cfg.maxItemPence).toBe(ABSOLUTE_MAX_ITEM_PENCE);
    expect(() => loadPayPalConfig({ ...base, PAYOUT_MAX_ITEM_PENCE: "1.5" })).toThrow();
  });

  it("masks emails for logs", () => {
    expect(maskEmail("sam@personal.example.com")).toBe("s**@personal.example.com");
  });
});
