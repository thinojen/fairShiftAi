import { connection } from "next/server";
import { Suspense } from "react";
import { CheckCircle2, CircleDashed, Clock3, Lock } from "lucide-react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { PageBody, PageSkeleton, Panel, StatCard } from "@/components/manager/kit";
import { AssistantChat } from "@/components/worker/assistant-chat";
import { ComparisonCard } from "@/components/worker/comparison-card";
import { PayQueryList, type WorkerQueryRow } from "@/components/worker/pay-query-list";
import { STATE_HINT, StateChip } from "@/components/worker/state-chip";
import { aiAvailability } from "@/lib/assistant/limits";
import { PAY_QUERY_STATUS_LABEL, PAYOUT_STATUS_LABEL } from "@/lib/assistant/labels";
import { getDb } from "@/lib/db/client";
import { getDemoRole } from "@/lib/demo/role";
import { formatDateTime, formatMinutes, formatShiftDate, formatTime, formatWeight } from "@/lib/format";
import { formatGBP } from "@/lib/money";
import { formatShareBp } from "@/lib/tips/compare";
import { getWorkerOverview, type WorkerShift } from "@/lib/worker/queries";

export default function WorkerPage() {
  return (
    <Suspense fallback={<div className="bg-sidebar min-h-screen md:w-64" />}>
      <WorkerHome />
    </Suspense>
  );
}

async function WorkerHome() {
  const role = await getDemoRole();
  if (role.kind !== "worker") {
    return (
      <AppShell role={role}>
        <PageHeader title="Worker view" />
        <PageBody>
          <p className="text-muted-foreground text-sm">Choose a worker in the sidebar (try Sam) to see their earnings and the AI assistant.</p>
        </PageBody>
      </AppShell>
    );
  }
  return (
    <AppShell role={role}>
      <Suspense fallback={<PageSkeleton />}>
        <WorkerDashboard workerId={role.workerId} />
      </Suspense>
    </AppShell>
  );
}

async function WorkerDashboard({ workerId }: { workerId: string }) {
  await connection();
  const o = await getWorkerOverview(getDb(), workerId);
  if (!o) return <PageBody>Worker not found.</PageBody>;
  const first = o.worker.name.split(" ")[0];
  const ai = aiAvailability();
  // Split by the clock (venue time): a shift is "past" only once its service has finished.
  const past = o.shifts.filter((s) => s.completed);
  const upcoming = o.shifts.filter((s) => !s.completed);
  const queryRows: WorkerQueryRow[] = o.payQueries.map((q) => {
    const sh = o.shifts.find((s) => s.assignmentId === q.shiftAssignmentId);
    const fieldLabel = q.field === "clock_out" ? "Clock-out" : q.field === "clock_in" ? "Clock-in" : "Break";
    const val = (v: string | null) => (v === null ? "missing" : q.field === "break_minutes" ? `${v} min` : formatDateTime(new Date(v)));
    return {
      id: q.id,
      status: q.status,
      statusLabel: PAY_QUERY_STATUS_LABEL[q.status] ?? q.status,
      shiftLabel: sh ? `${formatShiftDate(sh.date)} ${sh.service}` : "Shift",
      claimLabel: `${fieldLabel}: ${val(q.recordedValue)} → ${val(q.claimedValue)}`,
      note: q.resolutionNote,
      createdLabel: formatDateTime(q.createdAt),
    };
  });

  return (
    <>
      <PageHeader
        title={`Hi ${first}`}
        description={
          <span>
            <span className="capitalize">{o.worker.role}</span> · The Copper Lantern (demo) · figures from your records, payments via PayPal sandbox
          </span>
        }
      />
      <PageBody>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-6">
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <StatCard label="Paid via PayPal" value={formatGBP(o.totals.paidPence)} hint="Only payouts PayPal confirmed" icon={<CheckCircle2 />} tone="emerald" />
              <StatCard label="Allocated" value={formatGBP(o.totals.allocatedPence)} hint="Locked by manager · not necessarily paid" icon={<Lock />} />
              <StatCard label="Provisional" value={formatGBP(o.totals.provisionalPence)} hint="Calculated, not locked — may change" icon={<CircleDashed />} tone="amber" />
              <StatCard label="Hours worked" value={formatMinutes(o.totals.workedMinutes)} hint={`${past.length} shifts · ${o.totals.blockedCount} blocked`} icon={<Clock3 />} />
            </div>

            {o.weekOnWeek && <ComparisonCard c={o.weekOnWeek.comparison} />}

            <Panel title="Your shifts" description="Tap a shift to see how your share was worked out.">
              <ul className="-my-2 divide-y">
                {past.map((s) => (
                  <ShiftRow key={s.assignmentId} s={s} />
                ))}
                {upcoming.map((s) => (
                  <li key={s.assignmentId} className="text-muted-foreground flex items-center justify-between py-3 text-sm">
                    <span>
                      {formatShiftDate(s.date)} {s.service} · rota {formatTime(s.rotaStart)}–{formatTime(s.rotaEnd)}
                    </span>
                    <StateChip state="upcoming" />
                  </li>
                ))}
              </ul>
            </Panel>

            <div className="grid gap-6 xl:grid-cols-2">
              <Panel title="Payment history" description="PayPal sandbox payouts. A shift appears here only once a payout exists.">
                {past.some((s) => s.payout) ? (
                  <ul className="-my-2 divide-y">
                    {past
                      .filter((s) => s.payout)
                      .map((s) => (
                        <li key={s.assignmentId} className="py-2.5 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{formatShiftDate(s.date)}</span>
                            <span className="tabular-nums">{formatGBP(s.payout!.amountPence)}</span>
                          </div>
                          <p className="text-muted-foreground text-xs">
                            {PAYOUT_STATUS_LABEL[s.payout!.reconciliationIssue ? "needs_review" : s.payout!.status] ?? s.payout!.status}
                          </p>
                          {s.payout!.paypalBatchId && <p className="text-muted-foreground font-mono text-[11px] break-all">PayPal batch {s.payout!.paypalBatchId}</p>}
                          {s.payout!.paypalItemId && <p className="text-muted-foreground font-mono text-[11px] break-all">Item {s.payout!.paypalItemId}</p>}
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">No PayPal payouts yet. Amounts above are allocations or provisional figures — not payments.</p>
                )}
              </Panel>
              <Panel title="Pay queries" description="Drafts stay private until you send them.">
                <PayQueryList rows={queryRows} />
              </Panel>
            </div>

            <details className="text-muted-foreground text-xs">
              <summary className="hover:text-foreground cursor-pointer">What do the statuses mean?</summary>
              <ul className="mt-2 space-y-1.5">
                {(["blocked", "provisional", "allocated", "paid", "needs_review"] as const).map((k) => (
                  <li key={k} className="flex items-start gap-2">
                    <StateChip state={k} /> <span>{STATE_HINT[k]}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          <div className="lg:sticky lg:top-6">
            <AssistantChat firstName={first} enabled={ai.enabled} disabledReason={ai.enabled ? undefined : ai.reason} />
          </div>
        </div>
      </PageBody>
    </>
  );
}

function ShiftRow({ s }: { s: WorkerShift }) {
  return (
    <li>
      <details className="group py-3">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1">
          <div className="min-w-36 flex-1">
            <p className="text-sm font-medium">
              {formatShiftDate(s.date)} <span className="text-muted-foreground font-normal">· {s.service}</span>
            </p>
            <p className="text-muted-foreground text-xs">
              {s.workedMinutes !== null ? formatMinutes(s.workedMinutes) : "hours incomplete"} · policy {s.policy ? `v${s.policy.version}` : "—"}
              {s.hoursCorrected && " · hours corrected"}
            </p>
          </div>
          <span className="text-sm font-semibold tabular-nums">{s.sharePence !== null ? formatGBP(s.sharePence) : "—"}</span>
          <StateChip state={s.state} />
        </summary>
        <div className="bg-muted/50 mt-3 rounded-xl p-3 text-xs">
          {s.state === "blocked" ? (
            <p>{s.blockedReasons.join(". ")}. Nothing has been calculated for this shift yet.</p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Clocked</dt>
              <dd>
                {formatTime(s.clockIn)}–{formatTime(s.clockOut)} · break {s.breakMinutes}m
              </dd>
              <dt className="text-muted-foreground">Your points</dt>
              <dd className="tabular-nums">
                {formatMinutes(s.workedMinutes ?? 0)} ({s.workedMinutes} min) × {formatWeight(s.weightBp ?? 0)} = {(s.points ?? 0).toLocaleString("en-GB")}
              </dd>
              <dt className="text-muted-foreground">Team points</dt>
              <dd className="tabular-nums">
                {(s.totalPoints ?? 0).toLocaleString("en-GB")} · your share {s.totalPoints ? formatShareBp(Math.round(((s.points ?? 0) * 10000) / s.totalPoints)) : "—"}
              </dd>
              <dt className="text-muted-foreground">Tip pool</dt>
              <dd className="tabular-nums">
                {formatGBP(s.grossPence)}
                {s.isDemoPool && " (demo data)"}
              </dd>
              <dt className="text-muted-foreground">{s.state === "paid" ? "Paid" : s.locked ? "Allocated" : "Provisional share"}</dt>
              <dd className="font-semibold tabular-nums">{formatGBP(s.sharePence ?? 0)}</dd>
              {s.excludedReason && (
                <>
                  <dt className="text-muted-foreground">Note</dt>
                  <dd>{s.excludedReason}</dd>
                </>
              )}
              {s.hoursCorrected && (
                <>
                  <dt className="text-muted-foreground">Correction</dt>
                  <dd>Original clock-out: {s.originalClockOut ? formatDateTime(s.originalClockOut) : "not recorded"} ({s.correctionCount} correction{s.correctionCount === 1 ? "" : "s"})</dd>
                </>
              )}
            </dl>
          )}
        </div>
      </details>
    </li>
  );
}


