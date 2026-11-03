import { ArrowDownRight, ArrowUpRight, Info } from "lucide-react";
import { formatMinutes, formatShiftDate, formatWeight } from "@/lib/format";
import { formatGBP } from "@/lib/money";
import { formatShareBp, type Comparison } from "@/lib/tips/compare";
import { cn } from "@/lib/utils";
import { StateChip } from "./state-chip";

const signedGBP = (p: number) => `${p < 0 ? "−" : "+"}${formatGBP(Math.abs(p))}`;
const weekday = (d: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(new Date(`${d}T00:00:00Z`));

/** Display only: every figure is precomputed by lib/tips/compare.ts. */
export function ComparisonCard({ c }: { c: Comparison }) {
  const day = weekday(c.b.date);
  if (!c.comparable) {
    return (
      <section className="bg-card rounded-2xl border p-5 shadow-xs">
        <h2 className="text-sm font-semibold">This {day} vs last {day}</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {[c.a, c.b].map((p) => (
            <div key={p.shiftId} className="bg-muted/60 rounded-xl p-3">
              <p className="text-muted-foreground text-xs">{formatShiftDate(p.date)}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{p.sharePence !== null ? formatGBP(p.sharePence) : "—"}</p>
              <StateChip state={p.state} className="mt-1.5" />
            </div>
          ))}
        </div>
        <p className="text-muted-foreground mt-3 flex items-start gap-2 text-sm">
          <Info className="mt-0.5 size-4 shrink-0" /> {c.reason} Your manager needs to fix the record first.
        </p>
      </section>
    );
  }

  const down = c.deltaPence < 0;
  const max = Math.max(...c.steps.map((s) => Math.abs(s.deltaPence)), 1);
  return (
    <section className="bg-card overflow-hidden rounded-2xl border shadow-xs">
      <div className="bg-sidebar px-5 py-5 text-white">
        <p className="text-sidebar-foreground/80 text-xs font-medium tracking-wide uppercase">
          This {day} vs last {day}
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-1">
          <p className={cn("flex items-center gap-1 text-3xl font-semibold tabular-nums", down ? "text-[oklch(0.82_0.1_25)]" : "text-[oklch(0.85_0.12_163)]")}>
            {down ? <ArrowDownRight className="size-7" /> : <ArrowUpRight className="size-7" />}
            {signedGBP(c.deltaPence)}
          </p>
          <p className="text-sidebar-foreground/80 pb-1 text-sm">
            {formatGBP(c.a.sharePence!)} → {formatGBP(c.b.sharePence!)}
          </p>
        </div>
        {c.provisional && (
          <p className="bg-warning/20 mt-3 inline-block rounded-md px-2 py-1 text-xs text-white">
            Includes a provisional figure — not locked, not paid. It may change.
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 divide-x border-b">
        {[c.a, c.b].map((p, i) => (
          <div key={p.shiftId} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <p className="text-sm font-semibold">{formatShiftDate(p.date)}</p>
              <StateChip state={p.state} />
            </div>
            <dl className="mt-2 space-y-1 text-xs">
              <Row k="Tip pool" v={formatGBP(p.grossPence)} />
              <Row k="Your hours" v={formatMinutes(p.workerMinutes!)} />
              <Row k="Your share of points" v={formatShareBp(i === 0 ? c.pointsShareA_bp : c.pointsShareB_bp)} />
              <Row k="Staff sharing" v={String(p.eligibleCount ?? "—")} />
              <Row k="Policy" v={`v${p.policyVersion}`} />
              <Row k={p.state === "paid" ? "Paid" : "Your share"} v={formatGBP(p.sharePence!)} strong />
            </dl>
          </div>
        ))}
      </div>

      <div className="p-5">
        <p className="text-sm font-semibold">What changed</p>
        <ol className="mt-3 space-y-3">
          {c.steps.map((s, i) => (
            <li key={s.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  <span className="text-muted-foreground mr-1.5 tabular-nums">{i + 1}.</span>
                  {s.label}
                </span>
                <span className={cn("font-semibold tabular-nums", s.deltaPence < 0 ? "text-destructive" : "text-accent-foreground")}>{signedGBP(s.deltaPence)}</span>
              </div>
              <div className="bg-muted mt-1.5 h-2 overflow-hidden rounded-full">
                <div
                  className={cn("h-full rounded-full", s.deltaPence < 0 ? "bg-destructive/70" : "bg-primary")}
                  style={{ width: `${Math.max(4, Math.round((Math.abs(s.deltaPence) / max) * 100))}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
        {c.policyChanges.length > 0 && (
          <p className="text-muted-foreground mt-4 text-xs">
            Policy change between these shifts:{" "}
            {c.policyChanges.map((pc) => `${pc.role} weight ${formatWeight(pc.fromBp)} → ${formatWeight(pc.toBp)}`).join(", ")}.
          </p>
        )}
        <p className="text-muted-foreground mt-3 text-xs">
          Breakdown method: a fixed-order counterfactual (pool first, then your points, then the team). It&rsquo;s one fair way to split the change, not the
          only possible one. The steps add up exactly to {signedGBP(c.deltaPence)}.
        </p>
      </div>
    </section>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn("tabular-nums", strong && "text-sm font-semibold")}>{v}</dd>
    </div>
  );
}
