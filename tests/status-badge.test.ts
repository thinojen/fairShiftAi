/**
 * Regression: in the first real manager-UI sandbox payout (8 Nov, batch
 * TBMUQ4PFG2YKC) PayPal still reported the batch header as PROCESSING while all
 * five items were SUCCESS, so the badge read "Accepted · PayPal processing".
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BatchStatusBadge, PayoutStatusBadge } from "@/components/ui/status-badge";

const html = (status: string | null, allItemsPaid?: boolean) => renderToStaticMarkup(createElement(BatchStatusBadge, { status, allItemsPaid }));

describe("BatchStatusBadge", () => {
  it("says 'All items paid' once every item is confirmed, keeping PayPal's batch status in the tooltip", () => {
    const h = html("processing", true);
    expect(h).toContain("All items paid");
    expect(h).toContain('title="PayPal batch status: Accepted · PayPal processing"');
  });

  it("keeps PayPal's wording until every item is confirmed paid", () => {
    expect(html("processing", false)).toContain("Accepted · PayPal processing");
    expect(html("processing")).toContain("Accepted · PayPal processing");
    expect(html("pending", false)).toContain("Accepted · PayPal pending");
  });

  it("never overrides a failed, denied or canceled batch", () => {
    for (const s of ["error", "denied", "canceled"]) expect(html(s, true)).not.toContain("All items paid");
  });

  it("item badges: only SUCCESS is 'Paid'; a reconciliation issue is 'Needs review'", () => {
    expect(renderToStaticMarkup(createElement(PayoutStatusBadge, { status: "success" }))).toContain("Paid");
    expect(renderToStaticMarkup(createElement(PayoutStatusBadge, { status: "pending" }))).toContain("Pending");
    expect(renderToStaticMarkup(createElement(PayoutStatusBadge, { status: "success", issue: "amount mismatch" }))).toContain("Needs review");
  });
});
