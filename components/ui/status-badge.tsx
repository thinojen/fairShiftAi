import { Badge } from "@/components/ui/badge";

/** Payout item status → label. Only PayPal SUCCESS is ever shown as "Paid". */
const PAYOUT: Record<string, { label: string; variant: "success" | "warning" | "destructive" | "secondary" | "outline" }> = {
  success: { label: "Paid", variant: "success" },
  pending: { label: "Pending", variant: "secondary" },
  unclaimed: { label: "Unclaimed", variant: "warning" },
  onhold: { label: "On hold", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  returned: { label: "Returned", variant: "destructive" },
  blocked: { label: "Blocked", variant: "destructive" },
  refunded: { label: "Refunded", variant: "destructive" },
  reversed: { label: "Reversed", variant: "destructive" },
};

export function PayoutStatusBadge({ status }: { status: string }) {
  const s = PAYOUT[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

const SHIFT: Record<string, { label: string; variant: "success" | "warning" | "secondary" | "outline" | "default" }> = {
  open: { label: "Open", variant: "outline" },
  closed: { label: "Allocation locked", variant: "secondary" },
  paid: { label: "All paid", variant: "success" },
};

export function ShiftStatusBadge({ status }: { status: string }) {
  const s = SHIFT[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

const BATCH: Record<string, string> = {
  created: "Prepared — not sent",
  sending: "Sending…",
  error: "Send failed — retry safe",
  submitted: "Accepted by PayPal",
  pending: "Accepted · PayPal pending",
  processing: "Accepted · PayPal processing",
  success: "PayPal finished processing",
  denied: "Denied by PayPal",
  canceled: "Canceled",
};

export function BatchStatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="outline">No payout</Badge>;
  const tone = status === "error" || status === "denied" ? "destructive" : status === "success" ? "success" : "secondary";
  return <Badge variant={tone}>{BATCH[status] ?? status}</Badge>;
}

export function DemoPoolBadge() {
  return (
    <Badge variant="outline" title="Seeded demonstration amount — not funded through PayPal Orders">
      Demo pool
    </Badge>
  );
}
