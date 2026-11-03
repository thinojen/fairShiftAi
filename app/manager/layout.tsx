import Link from "next/link";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { getDemoRole } from "@/lib/demo/role";

export default function ManagerLayout({ children }: LayoutProps<"/manager">) {
  return (
    <Suspense fallback={<div className="bg-sidebar min-h-screen md:w-64" />}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}

/** Demo view gate (not auth): worker roles never render manager pages or their data. */
async function Gate({ children }: { children: React.ReactNode }) {
  const role = await getDemoRole();
  return (
    <AppShell role={role}>
      {role.kind === "manager" ? (
        children
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-sm text-center">
            <h1 className="text-lg font-semibold">You&rsquo;re viewing as {role.name}</h1>
            <p className="text-muted-foreground mt-2 text-sm">
              Manager pages are hidden in worker views. Switch to <strong>Manager</strong> in the sidebar, or{" "}
              <Link className="text-primary underline-offset-4 hover:underline" href="/worker">
                open your worker view
              </Link>
              .
            </p>
          </div>
        </div>
      )}
    </AppShell>
  );
}
