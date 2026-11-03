import { CheckCircle2, CircleDashed, Clock3, Lock, OctagonAlert, TriangleAlert } from "lucide-react";
import { STATE_SHORT } from "@/lib/assistant/labels";
import type { PeriodState } from "@/lib/tips/compare";
import { cn } from "@/lib/utils";

const STYLE: Record<PeriodState, { cls: string; Icon: typeof Lock; hint: string }> = {
  upcoming: { cls: "border-border text-muted-foreground bg-white", Icon: Clock3, hint: "This shift hasn't happened yet." },
  blocked: { cls: "border-destructive/30 bg-destructive/8 text-destructive", Icon: OctagonAlert, hint: "Hours are incomplete, so nothing has been calculated." },
  provisional: { cls: "border-warning/50 bg-warning/12 text-[oklch(0.45_0.11_70)]", Icon: CircleDashed, hint: "Calculated from current records. Not locked and not paid — it may change." },
  allocated: { cls: "border-info/30 bg-info/8 text-info", Icon: Lock, hint: "Locked by your manager. This is an allocation, not a payment yet." },
  paid: { cls: "border-primary/30 bg-accent text-accent-foreground", Icon: CheckCircle2, hint: "PayPal (sandbox) reports this payout as successful." },
  needs_review: { cls: "border-destructive/30 bg-destructive/8 text-destructive", Icon: TriangleAlert, hint: "There's a problem with this payment that your manager needs to look at." },
};

export function StateChip({ state, className }: { state: PeriodState; className?: string }) {
  const s = STYLE[state];
  return (
    <span
      title={s.hint}
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap", s.cls, className)}
    >
      <s.Icon className="size-3" aria-hidden />
      {STATE_SHORT[state]}
    </span>
  );
}

export const STATE_HINT = Object.fromEntries(Object.entries(STYLE).map(([k, v]) => [k, v.hint])) as Record<PeriodState, string>;
