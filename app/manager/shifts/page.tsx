import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/app-shell";
import { PageBody, PageSkeleton } from "@/components/manager/kit";
import { BatchStatusBadge, DemoPoolBadge, ShiftStatusBadge } from "@/components/ui/status-badge";
import { getDb } from "@/lib/db/client";
import { formatShiftDate } from "@/lib/format";
import { formatGBP } from "@/lib/money";
import { listShifts } from "@/lib/shifts/queries";

export default function ShiftsPage() {
  return (
    <>
      <PageHeader title="Shifts & payouts" description="Review hours, lock allocations and approve PayPal sandbox payouts." />
      <Suspense fallback={<PageSkeleton />}>
        <ShiftList />
      </Suspense>
    </>
  );
}

async function ShiftList() {
  await connection();
  const shifts = await listShifts(getDb());
  return (
    <PageBody>
      <div className="bg-card overflow-hidden rounded-2xl border shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/70 text-muted-foreground text-left text-xs">
              <tr>
                <th className="px-5 py-3 font-medium">Shift</th>
                <th className="px-5 py-3 font-medium">Staff</th>
                <th className="px-5 py-3 text-right font-medium">Tip pool</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Payout</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {shifts.map((s) => (
                <tr key={s.id} className="hover:bg-muted/40 group relative">
                  <td className="px-5 py-3.5">
                    <Link href={`/manager/shifts/${s.id}`} className="font-medium after:absolute after:inset-0">
                      {formatShiftDate(s.date)}
                    </Link>
                    <div className="text-muted-foreground text-xs capitalize">{s.service}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    {s.staffCount}
                    {s.uncoveredCount > 0 && <span className="text-warning ml-1.5 text-xs font-medium">+{s.uncoveredCount} uncovered</span>}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {s.isDemoPool && <DemoPoolBadge />}
                      <span className="font-semibold tabular-nums">{formatGBP(s.grossPence)}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <ShiftStatusBadge status={s.status} />
                  </td>
                  <td className="px-5 py-3.5">
                    <BatchStatusBadge status={s.batchStatus} allItemsPaid={s.status === "paid"} />
                  </td>
                  <td className="pr-4">
                    <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Demo pools are seeded demonstration amounts. They were not funded through PayPal Orders.
      </p>
    </PageBody>
  );
}
