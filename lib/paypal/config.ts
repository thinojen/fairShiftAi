/**
 * PayPal configuration. SANDBOX ONLY — by design, not by setting.
 *
 * The base URL is hard-coded to the sandbox and there is no variable that can
 * change it. Live credentials will simply fail to authenticate against the
 * sandbox, so this app cannot move real money.
 */

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com" as const;

/**
 * Required to create payouts (POST /v1/payments/payouts), per PayPal's API reference:
 * https://developer.paypal.com/api/payments.payouts-batch/v1/payouts-post
 */
export const PAYOUTS_SCOPE = "https://uri.paypal.com/payments/payouts";
export const WEBHOOKS_SCOPE = "https://uri.paypal.com/services/applications/webhooks";

export type ScopeCheck = {
  present: boolean;
  /** Other payout-related scopes on the token, to help diagnose a missing permission. */
  relatedScopes: string[];
};

/**
 * Whether the OAuth token grants a scope. Exact match only — a similar-looking
 * scope does not count, and nothing else (e.g. an API probe) can substitute.
 */
export function checkScope(tokenScopes: readonly string[], required: string): ScopeCheck {
  return {
    present: tokenScopes.includes(required),
    relatedScopes: tokenScopes.filter((s) => s !== required && /payout/i.test(s)),
  };
}

/** Hard ceilings that no env var can raise. */
export const ABSOLUTE_MAX_ITEM_PENCE = 50_000; // £500
export const ABSOLUTE_MAX_BATCH_PENCE = 200_000; // £2,000
export const MAX_ITEMS_PER_BATCH = 50;

export type PayPalConfig = {
  baseUrl: typeof PAYPAL_SANDBOX_BASE_URL;
  clientId: string;
  clientSecret: string;
  webhookId: string | undefined;
  /** Lower-cased sandbox recipient emails that may receive payouts. */
  recipientAllowlist: ReadonlySet<string>;
  maxItemPence: number;
  maxBatchPence: number;
};

type Env = Record<string, string | undefined>;

export class PayPalConfigError extends Error {
  name = "PayPalConfigError";
}

export function parseAllowlist(csv: string | undefined): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

function intEnv(env: Env, key: string, fallback: number, ceiling: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new PayPalConfigError(`${key} must be a positive integer number of pence`);
  }
  return Math.min(n, ceiling);
}

export function loadPayPalConfig(env: Env = process.env): PayPalConfig {
  if (env.PAYPAL_ENV && env.PAYPAL_ENV !== "sandbox") {
    throw new PayPalConfigError(
      `PAYPAL_ENV="${env.PAYPAL_ENV}" is not allowed. FairShift only runs against the PayPal sandbox.`,
    );
  }
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new PayPalConfigError("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
  }
  return {
    baseUrl: PAYPAL_SANDBOX_BASE_URL,
    clientId,
    clientSecret,
    webhookId: env.PAYPAL_WEBHOOK_ID?.trim() || undefined,
    recipientAllowlist: parseAllowlist(env.PAYPAL_SANDBOX_RECIPIENTS),
    maxItemPence: intEnv(env, "PAYOUT_MAX_ITEM_PENCE", 20_000, ABSOLUTE_MAX_ITEM_PENCE),
    maxBatchPence: intEnv(env, "PAYOUT_MAX_BATCH_PENCE", 100_000, ABSOLUTE_MAX_BATCH_PENCE),
  };
}

/** "sam.okafor@personal.example.com" → "s********@personal.example.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 2))}@${domain}`;
}
