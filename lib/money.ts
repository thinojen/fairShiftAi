/**
 * Money helpers. All amounts in FairShift are integer pence (GBP).
 * Never use floating-point arithmetic on money anywhere else in the codebase.
 */

export const CURRENCY = "GBP" as const;

export type Pence = number;

export function assertPence(value: number, label = "amount"): asserts value is Pence {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer number of pence, got ${value}`);
  }
}

/** 12345 → "123.45" — the string format PayPal expects. Pure integer maths, no floats. */
export function penceToDecimalString(pence: Pence): string {
  assertPence(pence);
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}${pounds}.${rem.toString().padStart(2, "0")}`;
}

/** "123.45" → 12345. Rejects anything that is not a plain 2-decimal-place amount. */
export function decimalStringToPence(value: string): Pence {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid money string: "${value}"`);
  const [, neg, pounds, frac = ""] = match;
  const pence = Number(pounds) * 100 + Number(frac.padEnd(2, "0"));
  assertPence(pence);
  return neg ? -pence : pence;
}

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: CURRENCY });

/** 12345 → "£123.45" for display only. */
export function formatGBP(pence: Pence): string {
  assertPence(pence);
  return gbp.format(Number(penceToDecimalString(pence)));
}
