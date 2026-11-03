import { connection } from "next/server";
import { Suspense } from "react";
import { CheckCircle2, CircleSlash } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { PageBody, PageSkeleton } from "@/components/manager/kit";
import { getDb } from "@/lib/db/client";
import { maskEmail } from "@/lib/format";
import { formatGBP } from "@/lib/money";
import { isAllowlistedRecipient } from "@/lib/payouts/approval";
import { listWorkers } from "@/lib/shifts/queries";

export default function StaffPage() {
  return (
    <>
      <PageHeader title="Staff" description="Synthetic demo team. Payouts go only to allowlisted PayPal sandbox accounts." />
      <Suspense fallback={<PageSkeleton />}>
        <StaffList />
      </Suspense>
    </>
  );
}

async function StaffList() {
  await connection();
  const workers = await listWorkers(getDb());
  return (
    <PageBody>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {workers.map((w) => {
          const ok = isAllowlistedRecipient(w.paypalEmail);
          return (
            <div key={w.id} className="bg-card rounded-2xl border p-5 shadow-xs">
              <div className="flex items-center gap-3">
                <span className="bg-sidebar flex size-10 items-center justify-center rounded-full text-sm font-semibold text-white">
                  {w.name
                    .split(" ")
                    .map((n) => n[0])
                    .join("")}
                </span>
                <div>
                  <p className="font-medium">{w.name}</p>
                  <p className="text-muted-foreground text-xs capitalize">
                    {w.role} · {formatGBP(w.hourlyRatePence)}/h
                  </p>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2 text-xs">
                {ok ? <CheckCircle2 className="text-primary size-4" /> : <CircleSlash className="text-muted-foreground size-4" />}
                <span className="font-mono">{maskEmail(w.paypalEmail)}</span>
              </div>
              <p className="text-muted-foreground mt-1 text-xs">{ok ? "Allowlisted sandbox recipient" : "Not allowlisted — payouts to this worker are refused"}</p>
            </div>
          );
        })}
      </div>
    </PageBody>
  );
}
