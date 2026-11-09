import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { AlertTriangle, ArrowRight, CalendarClock, CircleDollarSign, Lock, UserX } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { PageBody, PageSkeleton, Panel, StatCard } from "@/components/manager/kit";
import { BatchStatusBadge, DemoPoolBadge, PayoutStatusBadge, ShiftStatusBadge } from "@/components/ui/status-badge";
import { getDb } from "@/lib/db/client";
import { formatDateTime, formatShiftDate, formatWeight } from "@/lib/format";
import { formatGBP } from "@/lib/money";
import { getDashboardSummary } from "@/lib/shifts/queries";

export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="The Copper Lantern · demonstration venue" />
      <Suspense fallback={<PageSkeleton />}>
        <Overview />
      </Suspense>
    </>
  );
}

async function Overview() {
  await connection(); // always read fresh data at request time
  const d = await getDashboardSummary(getDb());
  const nextAction = d.shifts.find((s) => s.status === "open" && s.grossPence > 0) ?? d.shifts.find((s) => s.status === "closed" && !s.batchStatus);

  return (
    <PageBody>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open shifts" value={d.counts.openShifts} hint="Hours still being reviewed" icon={<CalendarClock />} />
        <StatCard label="Ready to pay" value={d.counts.awaitingPayout} hint="Allocation locked, no payout yet" icon={<Lock />} tone="amber" />
        <StatCard
          label="Paid via PayPal"
          value={formatGBP(d.counts.paidPence)}
          hint="Only items PayPal reports as SUCCESS · sandbox"
          icon={<CircleDollarSign />}
          tone="emerald"
        />
        <StatCard label="Uncovered slots" value={d.counts.uncoveredSlots} hint="Upcoming shifts needing cover" icon={<UserX />} />
      </div>

      {nextAction && (
        <Link
          href={`/manager/shifts/${nextAction.id}`}
          className="group border-primary/30 bg-accent/60 hover:bg-accent flex items-center justify-between gap-4 rounded-2xl border p-4 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className="bg-primary flex size-9 items-center justify-center rounded-lg text-white">
              <AlertTriangle className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold">Next: review {formatShiftDate(nextAction.date)} {nextAction.service}</p>
              <p className="text-muted-foreground text-xs">
                {formatGBP(nextAction.grossPence)} tip pool · {nextAction.staffCount} staff
              </p>
            </div>
          </div>
          <ArrowRight className="text-accent-foreground size-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Panel
          className="xl:col-span-2"
          title="Shifts"
          description="Tip pools and payout progress"
          action={
            <Link href="/manager/shifts" className="text-primary text-xs font-medium hover:underline">
              View all
            </Link>
          }
        >
          <ul className="-my-2 divide-y">
            {d.shifts.slice(0, 5).map((s) => (
              <li key={s.id}>
                <Link href={`/manager/shifts/${s.id}`} className="hover:bg-muted/60 -mx-2 flex flex-wrap items-center gap-3 rounded-lg px-2 py-3">
                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-medium">{formatShiftDate(s.date)}</p>
                    <p className="text-muted-foreground text-xs">
                      {s.service[0].toUpperCase() + s.service.slice(1)} · {s.staffCount} staff{s.uncoveredCount ? ` · ${s.uncoveredCount} uncovered` : ""}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{formatGBP(s.grossPence)}</span>
                  {s.isDemoPool && <DemoPoolBadge />}
                  <ShiftStatusBadge status={s.status} />
                  {s.batchStatus && <BatchStatusBadge status={s.batchStatus} allItemsPaid={s.status === "paid"} />}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="flex flex-col gap-6">
          {d.currentPolicy && (
            <Panel
              title={`Tip policy v${d.currentPolicy.version}`}
              description={`In force from ${formatShiftDate(d.currentPolicy.effectiveFrom)}`}
              action={
                <Link href="/manager/policy" className="text-primary text-xs font-medium hover:underline">
                  Details
                </Link>
              }
            >
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {Object.entries(d.currentPolicy.rules.weightsBp).map(([role, bp]) => (
                  <div key={role} className="flex justify-between">
                    <dt className="text-muted-foreground capitalize">{role}</dt>
                    <dd className="font-medium tabular-nums">{formatWeight(bp)}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          )}

          <Panel title="Recent payouts" description="Per-worker PayPal sandbox status">
            {d.recentPayouts.length === 0 ? (
              <p className="text-muted-foreground text-sm">No payouts yet. Lock an allocation and approve it to pay staff.</p>
            ) : (
              <ul className="-my-1.5 divide-y">
                {d.recentPayouts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.workerName}</p>
                      <p className="text-muted-foreground text-xs">{formatDateTime(p.updatedAt)}</p>
                    </div>
                    <span className="text-sm tabular-nums">{formatGBP(p.amountPence)}</span>
                    <PayoutStatusBadge status={p.status} issue={p.reconciliationIssue} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </PageBody>
  );
}
