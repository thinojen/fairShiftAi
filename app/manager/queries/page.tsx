import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ArrowRight, Bot, FileSearch } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { PageBody, PageSkeleton } from "@/components/manager/kit";
import { QueryReviewForm } from "@/components/manager/query-review";
import { PAY_QUERY_STATUS_LABEL } from "@/lib/assistant/labels";
import { getDb } from "@/lib/db/client";
import { formatDateTime, formatShiftDate } from "@/lib/format";
import { formatGBP } from "@/lib/money";
import { listManagerPayQueries, type PayQueryEvidence } from "@/lib/payqueries/commands";
import { cn } from "@/lib/utils";

export default function QueriesPage() {
  return (
    <>
      <PageHeader
        title="Pay queries"
        description="Workers' disputes with evidence. Accepting changes nothing by itself — correct hours on the shift page, then re-lock and approve as usual."
      />
      <Suspense fallback={<PageSkeleton />}>
        <Inbox />
      </Suspense>
    </>
  );
}

const TONE: Record<string, string> = {
  submitted: "bg-info/10 text-info",
  accepted: "bg-warning/15 text-[oklch(0.45_0.11_70)]",
  resolved: "bg-accent text-accent-foreground",
  rejected: "bg-destructive/10 text-destructive",
};

async function Inbox() {
  await connection();
  const rows = await listManagerPayQueries(getDb());
  if (!rows.length) {
    return (
      <PageBody>
        <div className="bg-card text-muted-foreground rounded-2xl border p-8 text-center text-sm shadow-xs">No pay queries have been sent yet.</div>
      </PageBody>
    );
  }
  const val = (field: string, v: string | null) => (v === null ? "missing" : field === "break_minutes" ? `${v} min break` : formatDateTime(new Date(v)));

  return (
    <PageBody>
      {rows.map(({ q, workerName }) => {
        const ev = q.evidenceJson as PayQueryEvidence | null;
        const fieldLabel = q.field === "clock_out" ? "Clock-out" : q.field === "clock_in" ? "Clock-in" : "Break";
        return (
          <article key={q.id} className="bg-card rounded-2xl border shadow-xs">
            <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">
                  {workerName} · {ev ? `${formatShiftDate(ev.shift.date)} ${ev.shift.service}` : "Shift"}
                </h2>
                <p className="text-muted-foreground text-xs">Sent {q.submittedAt ? formatDateTime(q.submittedAt) : "—"}</p>
              </div>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", TONE[q.status])}>{PAY_QUERY_STATUS_LABEL[q.status]}</span>
            </header>
            <div className="grid gap-5 p-5 lg:grid-cols-[1fr_1fr_320px]">
              <div className="space-y-3 text-sm">
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <span className="text-muted-foreground">{fieldLabel} recorded</span>
                  <span className="font-medium">{val(q.field, q.recordedValue)}</span>
                  <span className="text-muted-foreground">Worker claims</span>
                  <span className="font-medium">{val(q.field, q.claimedValue)}</span>
                </div>
                <blockquote className="bg-muted/60 rounded-lg p-3 text-sm italic">&ldquo;{q.workerMessage}&rdquo;</blockquote>
                {q.aiSummary && (
                  <p className="text-muted-foreground flex gap-2 text-xs">
                    <Bot className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <span className="font-medium">AI-written summary:</span> {q.aiSummary}
                    </span>
                  </p>
                )}
              </div>
              {ev && (
                <div className="text-xs">
                  <p className="text-muted-foreground mb-2 flex items-center gap-1.5 font-semibold tracking-wide uppercase">
                    <FileSearch className="size-3.5" /> Evidence (from records)
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">Rota</dt>
                    <dd>{formatDateTime(new Date(ev.rota.start))} – {formatDateTime(new Date(ev.rota.end))}</dd>
                    <dt className="text-muted-foreground">Recorded</dt>
                    <dd>
                      {ev.recorded.clockIn ? formatDateTime(new Date(ev.recorded.clockIn)) : "missing"} – {ev.recorded.clockOut ? formatDateTime(new Date(ev.recorded.clockOut)) : "missing"} ·
                      break {ev.recorded.breakMinutes}m
                    </dd>
                    <dt className="text-muted-foreground">Original</dt>
                    <dd>{ev.original.hoursCorrected ? `clock-out ${ev.original.clockOut ? formatDateTime(new Date(ev.original.clockOut)) : "not recorded"}` : "unchanged"}</dd>
                    {ev.corrections.map((c, i) => (
                      <div key={i} className="contents">
                        <dt className="text-muted-foreground">Correction</dt>
                        <dd>
                          {c.field.replace("_", " ")}: {c.from ? formatDateTime(new Date(c.from)) : "missing"} → {c.field === "break_minutes" ? `${c.to}m` : formatDateTime(new Date(c.to))} · “{c.reason}”
                        </dd>
                      </div>
                    ))}
                    <dt className="text-muted-foreground">Allocation</dt>
                    <dd>
                      {ev.allocation.state === "locked" || ev.allocation.state === "provisional"
                        ? `${ev.allocation.state} · ${formatGBP(ev.allocation.sharePence)} · policy v${ev.allocation.policyVersion}`
                        : ev.allocation.state}
                    </dd>
                    <dt className="text-muted-foreground">PayPal</dt>
                    <dd>{ev.payout ? `${ev.payout.status}${ev.payout.paypalBatchId ? ` · ${ev.payout.paypalBatchId}` : ""}` : "no payout"}</dd>
                  </dl>
                  {ev && (
                    <Link href={`/manager/shifts/${ev.shift.id}`} className="text-primary mt-3 inline-flex items-center gap-1 font-medium hover:underline">
                      Open shift to correct hours <ArrowRight className="size-3.5" />
                    </Link>
                  )}
                </div>
              )}
              <div>
                {q.resolutionNote && <p className="text-muted-foreground mb-3 text-xs">Note: &ldquo;{q.resolutionNote}&rdquo;</p>}
                <QueryReviewForm queryId={q.id} status={q.status} />
              </div>
            </div>
          </article>
        );
      })}
    </PageBody>
  );
}
