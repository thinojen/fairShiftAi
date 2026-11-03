import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell";
import { PageBody, PageSkeleton, Panel } from "@/components/manager/kit";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/lib/db/client";
import { formatMinutes, formatShiftDate, formatWeight } from "@/lib/format";
import { listPolicies } from "@/lib/shifts/queries";

export default function PolicyPage() {
  return (
    <>
      <PageHeader
        title="Tipping policy"
        description="Written and versioned. Each shift is calculated with the version in force on its date, and every allocation records which version it used."
      />
      <Suspense fallback={<PageSkeleton />}>
        <Policies />
      </Suspense>
    </>
  );
}

async function Policies() {
  await connection();
  const policies = await listPolicies(getDb());
  const today = new Date().toISOString().slice(0, 10);
  const current = policies.find((p) => p.effectiveFrom <= today);
  return (
    <PageBody>
      {policies.map((p) => (
        <Panel
          key={p.id}
          title={
            <span className="flex items-center gap-2">
              Version {p.version}
              {p.id === current?.id && <Badge variant="success">Current</Badge>}
            </span>
          }
          description={`In force from ${formatShiftDate(p.effectiveFrom)}`}
        >
          <p className="max-w-3xl text-sm leading-relaxed">{p.textSummary}</p>
          <div className="mt-5 grid gap-6 md:grid-cols-[1fr_auto]">
            <table className="w-full max-w-md text-sm">
              <thead className="text-muted-foreground text-left text-xs">
                <tr>
                  <th className="pb-2 font-medium">Role</th>
                  <th className="pb-2 text-right font-medium">Weight</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {Object.entries(p.rules.weightsBp).map(([role, bp]) => (
                  <tr key={role}>
                    <td className="py-2 capitalize">{role}</td>
                    <td className="py-2 text-right font-medium tabular-nums">{formatWeight(bp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="bg-muted/60 grid h-fit grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl p-4 text-xs">
              <dt className="text-muted-foreground">Method</dt>
              <dd>Minutes worked × role weight</dd>
              <dt className="text-muted-foreground">Minimum to qualify</dt>
              <dd>{formatMinutes(p.rules.minMinutesToQualify)}</dd>
              <dt className="text-muted-foreground">Rounding</dt>
              <dd>Whole pence; leftovers to largest remainders</dd>
            </dl>
          </div>
        </Panel>
      ))}
    </PageBody>
  );
}
