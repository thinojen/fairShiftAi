import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AlertOctagon, AlertTriangle, ArrowLeft, FileClock, History, Info, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { AllocationGrid, type AllocationRow } from "@/components/manager/allocation-grid";
import { Reveal } from "@/components/manager/collapsible";
import { PageBody, PageSkeleton, Panel, StatCard } from "@/components/manager/kit";
import {
  ApprovePayoutForm,
  CorrectionForm,
  RefreshStatusForm,
  ReopenForm,
  SaveAllocationForm,
} from "@/components/manager/shift-actions";
import { Badge } from "@/components/ui/badge";
import { BatchStatusBadge, DemoPoolBadge, PayoutStatusBadge, ShiftStatusBadge } from "@/components/ui/status-badge";
import { getDb } from "@/lib/db/client";
import { formatDateTime, formatMinutes, formatShiftDate, formatTime, toLondonLocalInput } from "@/lib/format";
import { formatGBP } from "@/lib/money";
import { payoutAvailability } from "@/lib/payouts/approval";
import { getShiftReview, type ShiftReview } from "@/lib/shifts/queries";
import type { WorkerTrace } from "@/lib/tips/engine";
import { cn } from "@/lib/utils";

export default function ShiftPage({ params }: PageProps<"/manager/shifts/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ShiftDetail params={params} />
    </Suspense>
  );
}

async function ShiftDetail({ params }: { params: PageProps<"/manager/shifts/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  const r = await getShiftReview(getDb(), decodeURIComponent(id));
  if (!r) notFound();

  const { shift, pool, policy } = r;
  const errors = r.flags.filter((f) => f.severity === "error");
  const warnings = r.flags.filter((f) => f.severity === "warning");
  const locked = shift.status !== "open";
  const batch = r.batch;
  const payoutStatusByWorker = new Map(r.payouts.map((p) => [p.workerId, p.reconciliationIssue ? "review" : p.status]));

  // Rows: saved allocation once locked; otherwise the live preview.
  let rows: AllocationRow[] = [];
  let totalPoints = 0;
  if (locked) {
    rows = r.saved.map((a) => {
      const t = a.explanationJson as WorkerTrace & { totalPoints: number };
      totalPoints = t.totalPoints;
      return toRow(t, a.workerName, payoutStatusByWorker.get(a.workerId));
    });
  } else if (r.preview?.ok) {
    totalPoints = r.preview.totalPoints;
    rows = r.preview.workers.map((w) => toRow(w, w.workerName ?? w.workerId));
  }
  const payableTotal = locked ? r.saved.reduce((n, a) => n + a.sharePence, 0) : 0;
  const payableCount = locked ? r.saved.filter((a) => a.sharePence > 0).length : 0;
  const availability = payoutAvailability();
  const canRetry = batch && ["created", "error", "sending"].includes(batch.status);

  return (
    <>
      <PageHeader
        title={`${formatShiftDate(shift.date)} · ${shift.service[0].toUpperCase()}${shift.service.slice(1)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link href="/manager/shifts" className="hover:text-foreground inline-flex items-center gap-1">
              <ArrowLeft className="size-3.5" /> All shifts
            </Link>
            <span aria-hidden>·</span>
            <ShiftStatusBadge status={shift.status} />
            {batch && <BatchStatusBadge status={batch.status} allItemsPaid={shift.status === "paid"} />}
          </span>
        }
      />
      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Tip pool"
            value={pool ? formatGBP(pool.grossPence) : "—"}
            hint={pool?.isDemo ? <span className="inline-flex items-center gap-1.5"><DemoPoolBadge /> Not funded via PayPal Orders</span> : "Card tips"}
          />
          <StatCard
            label="Policy applied"
            value={policy ? `v${policy.version}` : "None"}
            hint={policy ? `In force from ${formatShiftDate(policy.effectiveFrom)}` : "No policy covers this date"}
          />
          <StatCard label="Staff on shift" value={r.assignments.filter((a) => a.workerId).length} hint={`${r.assignments.filter((a) => a.status === "uncovered").length} uncovered slot(s)`} />
          <StatCard
            label="Hours check"
            value={errors.length ? `${errors.length} blocking` : warnings.length ? `${warnings.length} to review` : "All clear"}
            tone={errors.length ? "amber" : "emerald"}
            hint={errors.length ? "Fix before calculating" : "Ready to calculate"}
          />
        </div>

        {(errors.length > 0 || warnings.length > 0) && (
          <section aria-label="Hours warnings" className="flex flex-col gap-2">
            {errors.map((f) => (
              <div key={f.assignmentId + f.type} className="border-destructive/30 bg-destructive/5 flex items-start gap-3 rounded-xl border p-3.5 text-sm">
                <AlertOctagon className="text-destructive mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="font-medium">{f.message}</p>
                  <p className="text-muted-foreground text-xs">Tips can&rsquo;t be calculated until this is fixed. Correct it below — the original record is kept.</p>
                </div>
              </div>
            ))}
            {warnings.map((f) => (
              <div key={f.assignmentId + f.type} className="border-warning/40 bg-warning/10 flex items-start gap-3 rounded-xl border p-3.5 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[oklch(0.55_0.13_70)]" />
                <p>{f.message}</p>
              </div>
            ))}
          </section>
        )}

        <Panel title="Staff & hours" description="Times in UK local time. Corrections are audited and never overwrite the original record.">
          <ul className="-my-3 divide-y">
            {r.assignments.map((a) => (
              <AssignmentRow key={a.id} a={a} r={r} canEdit={!batch} />
            ))}
          </ul>
        </Panel>

        <Panel
          title={locked ? "Locked allocation" : "Allocation preview"}
          description={
            policy
              ? `Minutes worked × role weight (policy v${policy.version}). Calculated by the FairShift engine in whole pence; leftover pennies go to the largest remainders.`
              : undefined
          }
          action={locked && !batch ? <ReopenForm shiftId={shift.id} /> : undefined}
        >
          {!locked && r.preview && !r.preview.ok ? (
            <div className="bg-muted flex items-start gap-3 rounded-xl p-4 text-sm">
              <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">No allocation calculated</p>
                <ul className="text-muted-foreground mt-1 list-disc pl-4">
                  {r.preview.blockers.map((b, i) => (
                    <li key={i}>{b.message}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : rows.length ? (
            <>
              <AllocationGrid rows={rows} totalPoints={totalPoints} showPayout={!!batch} />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">
                  {totalPoints.toLocaleString("en-GB")} total points · {rows.filter((x) => x.eligible).length} eligible
                </span>
                <span className="font-semibold">
                  Allocated {formatGBP(rows.reduce((n, x) => n + x.sharePence, 0))} of {formatGBP(pool?.grossPence ?? 0)}
                </span>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">Nothing to allocate for this shift.</p>
          )}
        </Panel>

        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title="Manager approval" description="Two steps: lock the allocation, then approve the payout.">
            {!locked ? (
              <div className="flex flex-col gap-3">
                <p className="text-muted-foreground text-sm">
                  Locking re-runs the calculation on the server and stores each worker&rsquo;s share with its full calculation trace and policy version.
                </p>
                <SaveAllocationForm shiftId={shift.id} disabled={!r.preview?.ok || (pool?.grossPence ?? 0) === 0} />
              </div>
            ) : batch && !canRetry ? (
              <p className="flex items-start gap-2 text-sm">
                <ShieldCheck className="text-primary mt-0.5 size-4 shrink-0" />
                Approved and sent to PayPal. Hours and allocation are now locked; disputes go through a pay query.
              </p>
            ) : (
              <ApprovePayoutForm
                shiftId={shift.id}
                totalLabel={formatGBP(payableTotal)}
                recipients={payableCount}
                retry={!!canRetry}
                enabled={availability.enabled}
                disabledReason={availability.enabled ? undefined : availability.reason}
              />
            )}
          </Panel>

          <Panel
            title="PayPal payout"
            description="Sandbox · each worker is paid only when their own item reports SUCCESS"
            action={batch?.paypalBatchId ? <RefreshStatusForm shiftId={shift.id} /> : undefined}
          >
            {!batch ? (
              <p className="text-muted-foreground text-sm">No payout requested yet.</p>
            ) : (
              <div className="flex flex-col gap-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                  <dt className="text-muted-foreground">Batch</dt>
                  <dd><BatchStatusBadge status={batch.status} allItemsPaid={shift.status === "paid"} /></dd>
                  <dt className="text-muted-foreground">sender_batch_id</dt>
                  <dd className="font-mono break-all">{batch.senderBatchId}</dd>
                  <dt className="text-muted-foreground">PayPal batch ID</dt>
                  <dd className="font-mono break-all">{batch.paypalBatchId ?? "— not accepted yet"}</dd>
                  <dt className="text-muted-foreground">Send attempts</dt>
                  <dd>{batch.sendAttempts}</dd>
                  <dt className="text-muted-foreground">Last checked</dt>
                  <dd>{batch.lastStatusCheckAt ? formatDateTime(batch.lastStatusCheckAt) : "Never"}</dd>
                </dl>
                {batch.lastError && (
                  <p className="bg-warning/10 rounded-lg p-3 text-xs">{batch.lastError}</p>
                )}
                <ul className="divide-y rounded-xl border">
                  {r.payouts.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                      <span className="min-w-28 flex-1 font-medium">{p.workerName}</span>
                      <span className="tabular-nums">{formatGBP(p.amountPence)}</span>
                      <PayoutStatusBadge status={p.status} issue={p.reconciliationIssue} />
                      {p.reconciliationIssue && <span className="text-destructive w-full text-xs">{p.reconciliationIssue}</span>}
                      {p.errorMessage && <span className="text-destructive w-full text-xs">{p.errorMessage}</span>}
                      {(p.status === "unclaimed" || p.status === "failed") && (
                        <span className="text-muted-foreground w-full text-xs">
                          Not re-sent automatically. A corrective payout needs separate manager authorisation (coming in a later milestone).
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        </div>
      </PageBody>
    </>
  );
}

function toRow(t: WorkerTrace, worker: string, payoutStatus?: string): AllocationRow {
  return {
    workerId: t.workerId,
    worker,
    role: t.role,
    workedMinutes: t.workedMinutes,
    weightBp: t.weightBp,
    points: t.points,
    sharePence: t.sharePence,
    remainderPence: t.remainderPence,
    eligible: t.eligible,
    note: t.excludedReason ?? (t.remainderPence ? "+1p from rounding" : ""),
    payoutStatus,
  };
}

function AssignmentRow({ a, r, canEdit }: { a: ShiftReview["assignments"][number]; r: ShiftReview; canEdit: boolean }) {
  const flagged = r.flags.some((f) => f.assignmentId === a.id && f.severity === "error");
  if (!a.workerId) {
    return (
      <li className="flex flex-wrap items-center gap-3 py-3 text-sm">
        <span className="text-muted-foreground min-w-36 flex-1 italic">Uncovered {a.role} slot</span>
        <span className="text-muted-foreground text-xs">
          Rota {formatTime(a.scheduledStart)}–{formatTime(a.scheduledEnd)}
        </span>
        <Badge variant="warning">Needs cover</Badge>
      </li>
    );
  }
  const worked =
    a.clockIn && a.clockOut ? Math.floor((a.clockOut.getTime() - a.clockIn.getTime()) / 60_000) - a.breakMinutes : null;
  return (
    <li className={cn("py-3", flagged && "bg-destructive/[0.04] -mx-5 px-5")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="min-w-36 flex-1">
          <p className="font-medium">{a.workerName}</p>
          <p className="text-muted-foreground text-xs capitalize">{a.role}</p>
        </div>
        <div className="w-24 text-xs">
          <p className="text-muted-foreground">Rota</p>
          <p className="tabular-nums">{formatTime(a.scheduledStart)}–{formatTime(a.scheduledEnd)}</p>
        </div>
        <div className="w-28 text-xs">
          <p className="text-muted-foreground">Clocked</p>
          <p className="tabular-nums">
            {formatTime(a.clockIn)}–
            <span className={cn(!a.clockOut && "text-destructive font-semibold")}>{a.clockOut ? formatTime(a.clockOut) : "missing"}</span>
          </p>
        </div>
        <div className="w-12 text-xs">
          <p className="text-muted-foreground">Break</p>
          <p className="tabular-nums">{a.breakMinutes}m</p>
        </div>
        <div className="w-16 text-right text-xs">
          <p className="text-muted-foreground">Worked</p>
          <p className="font-semibold tabular-nums">{worked === null ? "—" : formatMinutes(worked)}</p>
        </div>
        {a.hoursCorrected && (
          <Badge variant="secondary" title="Hours were manually corrected — see history">
            <FileClock /> Corrected
          </Badge>
        )}
        {canEdit && (
          <Reveal label={flagged ? "Fix hours" : "Correct"}>
            <CorrectionForm
              assignmentId={a.id}
              workerName={a.workerName ?? "worker"}
              defaults={{
                clock_in: toLondonLocalInput(a.clockIn ?? a.scheduledStart),
                clock_out: toLondonLocalInput(a.clockOut ?? a.scheduledEnd),
                break_minutes: String(a.breakMinutes),
              }}
            />
          </Reveal>
        )}
      </div>
      {a.corrections.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1.5">
            <History className="size-3.5" /> Correction history ({a.corrections.length}) · original clock-out:{" "}
            {a.originalClockOut ? formatDateTime(a.originalClockOut) : "not recorded"}
          </summary>
          <ol className="mt-2 space-y-1.5 border-l pl-3">
            {a.corrections.map((c) => (
              <li key={c.id}>
                <span className="font-medium">{c.field.replace("_", " ")}</span>: {fmtValue(c.field, c.originalValue)} → {fmtValue(c.field, c.newValue)}
                <span className="text-muted-foreground">
                  {" "}
                  · {c.actor} · {formatDateTime(c.createdAt)} · “{c.reason}”
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

function fmtValue(field: string, v: string | null) {
  if (v === null) return "missing";
  if (field === "break_minutes") return `${v}m`;
  return formatDateTime(new Date(v));
}


