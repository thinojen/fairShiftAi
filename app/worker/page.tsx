import { Suspense } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { PageBody } from "@/components/manager/kit";
import { getDemoRole } from "@/lib/demo/role";

export default function WorkerPage() {
  return (
    <Suspense fallback={<div className="bg-sidebar min-h-screen md:w-64" />}>
      <WorkerHome />
    </Suspense>
  );
}

/** Placeholder until Milestone 3. Shows no financial data for any worker yet. */
async function WorkerHome() {
  const role = await getDemoRole();
  return (
    <AppShell role={role}>
      <PageHeader title={role.kind === "worker" ? `Hi ${role.name.split(" ")[0]}` : "Worker view"} />
      <PageBody>
        <div className="bg-card max-w-xl rounded-2xl border p-6 shadow-xs">
          <p className="font-medium">Your earnings view is coming in the next milestone.</p>
          <p className="text-muted-foreground mt-2 text-sm">
            You&rsquo;ll see your hours, your share of each tip pool, your PayPal payout status, and be able to ask
            &ldquo;why was I paid less this Friday?&rdquo;.
          </p>
          {role.kind === "manager" && <p className="text-muted-foreground mt-3 text-sm">Switch to a worker in the sidebar to preview it.</p>}
        </div>
      </PageBody>
    </AppShell>
  );
}
