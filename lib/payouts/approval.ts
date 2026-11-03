/**
 * Server-side payout authorisation. Independent of the demo role cookie.
 *
 * Payouts run only when ALL of these hold:
 *   PAYOUTS_ENABLED === "true"        (off by default — the public demo cannot pay)
 *   MANAGER_APPROVAL_CODE set, ≥ 12 chars
 *   PayPal sandbox credentials set
 * and the request supplies the correct approval code within the rate limit.
 */
import { createHash, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export const MIN_APPROVAL_CODE_LENGTH = 12;

export type PayoutAvailability =
  | { enabled: true }
  | { enabled: false; reason: string };

export function payoutAvailability(env: Env = process.env): PayoutAvailability {
  if (env.PAYOUTS_ENABLED !== "true") {
    return { enabled: false, reason: "Payouts are disabled in this demo environment (PAYOUTS_ENABLED is not \"true\")." };
  }
  if ((env.MANAGER_APPROVAL_CODE ?? "").length < MIN_APPROVAL_CODE_LENGTH) {
    return { enabled: false, reason: `MANAGER_APPROVAL_CODE must be set (at least ${MIN_APPROVAL_CODE_LENGTH} characters).` };
  }
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    return { enabled: false, reason: "PayPal sandbox credentials are not configured." };
  }
  return { enabled: true };
}

/** Constant-time comparison (hashing first makes lengths equal). */
export function approvalCodeMatches(candidate: string, env: Env = process.env): boolean {
  const expected = env.MANAGER_APPROVAL_CODE ?? "";
  if (expected.length < MIN_APPROVAL_CODE_LENGTH) return false;
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Fixed-window attempt limiter. In-memory: suits a single Render instance; it
 * resets on restart (documented limitation). Counts EVERY attempt, not only
 * failures, so it also throttles hammering with a correct code.
 */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly perKey = 5,
    private readonly global = 20,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt. Returns false (and records nothing) if over the limit. */
  tryConsume(key: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const t = this.now();
    const fresh = (k: string) => (this.hits.get(k) ?? []).filter((x) => t - x < this.windowMs);
    const mine = fresh(key);
    const all = fresh("*");
    if (mine.length >= this.perKey || all.length >= this.global) {
      const oldest = Math.min(...(mine.length >= this.perKey ? mine : all));
      return { allowed: false, retryAfterSec: Math.ceil((this.windowMs - (t - oldest)) / 1000) };
    }
    this.hits.set(key, [...mine, t]);
    this.hits.set("*", [...all, t]);
    return { allowed: true };
  }
}

export const approvalLimiter = new AttemptLimiter();

/** Whether an email is on the sandbox payout allowlist (display helper; guards enforce it). */
export function isAllowlistedRecipient(email: string, env: Env = process.env): boolean {
  const list = (env.PAYPAL_SANDBOX_RECIPIENTS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

export type PayoutAuthorisation =
  | { authorised: true }
  | { authorised: false; tone: "warning" | "error"; message: string };

/**
 * The ONLY gate in front of a payout. Note what it does NOT take: the demo role
 * cookie. Choosing "Manager" in the role switcher grants nothing here — a
 * payout needs payouts enabled on the server, a correct approval code, an
 * attempt within the rate limit, and the reviewed confirmation.
 */
export function authorisePayout(input: {
  approvalCode: string;
  confirmedReviewed: boolean;
  clientKey: string;
  env?: Env;
  limiter?: AttemptLimiter;
}): PayoutAuthorisation {
  const env = input.env ?? process.env;
  const availability = payoutAvailability(env);
  if (!availability.enabled) return { authorised: false, tone: "warning", message: availability.reason };

  const limit = (input.limiter ?? approvalLimiter).tryConsume(input.clientKey);
  if (!limit.allowed) {
    return { authorised: false, tone: "error", message: `Too many approval attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} min.` };
  }
  if (!approvalCodeMatches(input.approvalCode, env)) {
    return { authorised: false, tone: "error", message: "Approval code is incorrect. Nothing was sent." };
  }
  if (!input.confirmedReviewed) {
    return { authorised: false, tone: "error", message: "Confirm you have reviewed the allocation." };
  }
  return { authorised: true };
}
