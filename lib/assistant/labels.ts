/** Deterministic, plain-English status wording shared by the dashboard and the assistant. */
import type { PeriodState } from "../tips/compare";

export const STATE_LABEL: Record<PeriodState, string> = {
  upcoming: "Upcoming shift",
  blocked: "Blocked — hours incomplete, nothing calculated",
  provisional: "Provisional — calculated, not locked, not paid",
  allocated: "Allocated — locked by the manager, not paid yet",
  paid: "Paid via PayPal (sandbox)",
  needs_review: "Needs review — payment issue",
};

export const STATE_SHORT: Record<PeriodState, string> = {
  upcoming: "Upcoming",
  blocked: "Blocked",
  provisional: "Provisional",
  allocated: "Allocated",
  paid: "Paid",
  needs_review: "Needs review",
};

export const PAYOUT_STATUS_LABEL: Record<string, string> = {
  pending: "PayPal payout pending — not received yet",
  success: "Paid — PayPal reports success",
  failed: "PayPal payout failed",
  unclaimed: "Unclaimed — PayPal is holding it for the recipient",
  returned: "Returned by PayPal",
  onhold: "On hold at PayPal",
  blocked: "Blocked by PayPal",
  refunded: "Refunded",
  reversed: "Reversed",
  needs_review: "Needs review — PayPal's record doesn't match ours",
};

export const PAY_QUERY_STATUS_LABEL: Record<string, string> = {
  draft: "Draft — not sent",
  submitted: "With the manager",
  accepted: "Accepted — manager is correcting records",
  resolved: "Resolved",
  rejected: "Not upheld",
};
