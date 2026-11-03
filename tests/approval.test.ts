import { describe, expect, it } from "vitest";
import { approvalCodeMatches, AttemptLimiter, isAllowlistedRecipient, payoutAvailability } from "@/lib/payouts/approval";

const ready = {
  PAYOUTS_ENABLED: "true",
  MANAGER_APPROVAL_CODE: "correct-horse-battery",
  PAYPAL_CLIENT_ID: "id",
  PAYPAL_CLIENT_SECRET: "secret",
};

describe("payout availability (off by default)", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(payoutAvailability({}).enabled).toBe(false);
    expect(payoutAvailability({ ...ready, PAYOUTS_ENABLED: "1" }).enabled).toBe(false);
    expect(payoutAvailability({ ...ready, PAYOUTS_ENABLED: undefined }).enabled).toBe(false);
  });
  it("requires a long-enough approval code and PayPal credentials", () => {
    expect(payoutAvailability({ ...ready, MANAGER_APPROVAL_CODE: "short" }).enabled).toBe(false);
    expect(payoutAvailability({ ...ready, PAYPAL_CLIENT_SECRET: "" }).enabled).toBe(false);
    expect(payoutAvailability(ready).enabled).toBe(true);
  });
});

describe("approval code", () => {
  it("matches only the exact code", () => {
    expect(approvalCodeMatches("correct-horse-battery", ready)).toBe(true);
    expect(approvalCodeMatches("correct-horse-batter", ready)).toBe(false);
    expect(approvalCodeMatches("", ready)).toBe(false);
  });
  it("never matches when no code is configured", () => {
    expect(approvalCodeMatches("", {})).toBe(false);
    expect(approvalCodeMatches("anything", { MANAGER_APPROVAL_CODE: "short" })).toBe(false);
  });
});

describe("AttemptLimiter", () => {
  it("allows 5 attempts per key per window, then blocks", () => {
    let t = 0;
    const lim = new AttemptLimiter(5, 20, 60_000, () => t);
    for (let i = 0; i < 5; i++) expect(lim.tryConsume("ip1").allowed).toBe(true);
    const blocked = lim.tryConsume("ip1");
    expect(blocked.allowed).toBe(false);
    expect(lim.tryConsume("ip2").allowed).toBe(true); // other clients unaffected
    t = 60_001;
    expect(lim.tryConsume("ip1").allowed).toBe(true); // window passed
  });
  it("applies a global cap across all keys", () => {
    const lim = new AttemptLimiter(5, 3, 60_000, () => 0);
    expect(lim.tryConsume("a").allowed).toBe(true);
    expect(lim.tryConsume("b").allowed).toBe(true);
    expect(lim.tryConsume("c").allowed).toBe(true);
    expect(lim.tryConsume("d").allowed).toBe(false);
  });
});

describe("recipient allowlist", () => {
  it("is case-insensitive", () => {
    expect(isAllowlistedRecipient("Sam@X.com", { PAYPAL_SANDBOX_RECIPIENTS: "sam@x.com, p@x.com" })).toBe(true);
    expect(isAllowlistedRecipient("z@x.com", { PAYPAL_SANDBOX_RECIPIENTS: "sam@x.com" })).toBe(false);
  });
});
