import Link from "next/link";
import { CalendarClock, Inbox, LayoutDashboard, PiggyBank, ScrollText, ShieldCheck, Users, Wallet } from "lucide-react";
import { switchRoleAction } from "@/app/actions";
import { NavLink } from "@/components/nav-link";
import { DEMO_ROLES, roleValue, type DemoRole } from "@/lib/demo/role";

const NAV = [
  { href: "/manager", label: "Overview", icon: LayoutDashboard },
  { href: "/manager/shifts", label: "Shifts & payouts", icon: CalendarClock },
  { href: "/manager/queries", label: "Pay queries", icon: Inbox },
  { href: "/manager/staff", label: "Staff", icon: Users },
  { href: "/manager/policy", label: "Tip policy", icon: ScrollText },
];

export function AppShell({ role, children }: { role: DemoRole; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="bg-sidebar text-sidebar-foreground flex shrink-0 flex-col md:sticky md:top-0 md:h-screen md:w-64">
        <Link href={role.kind === "manager" ? "/manager" : "/worker"} className="flex items-center gap-2.5 px-5 py-5">
          <span className="bg-primary flex size-8 items-center justify-center rounded-lg text-white">
            <Wallet className="size-4" />
          </span>
          <span className="text-base font-semibold tracking-tight text-white">FairShift</span>
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white/70 uppercase">AI</span>
        </Link>

        {role.kind === "worker" && (
          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0">
            <NavLink href="/worker" exact>
              <PiggyBank className="size-4" />
              My earnings
            </NavLink>
          </nav>
        )}
        {role.kind === "manager" && (
          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0">
            {NAV.map((n) => (
              <NavLink key={n.href} href={n.href} exact={n.href === "/manager"}>
                <n.icon className="size-4" />
                {n.label}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="border-sidebar-border mt-auto hidden border-t p-4 md:block">
          <div className="text-sidebar-muted mb-3 flex items-start gap-2 text-xs leading-relaxed">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            <span>Demo · synthetic data · PayPal sandbox only</span>
          </div>
          <RoleSwitcher role={role} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-white">
        <div className="border-b px-4 py-2 md:hidden">
          <RoleSwitcher role={role} light />
        </div>
        {children}
      </div>
    </div>
  );
}

function RoleSwitcher({ role, light = false }: { role: DemoRole; light?: boolean }) {
  return (
    <form action={switchRoleAction} className="flex flex-col gap-1.5">
      <label htmlFor={light ? "role-m" : "role"} className={light ? "text-muted-foreground text-xs" : "text-sidebar-muted text-xs"}>
        View as (demo role — not a login)
      </label>
      <div className="flex gap-2">
        <select
          id={light ? "role-m" : "role"}
          name="role"
          defaultValue={roleValue(role)}
          className={
            light
              ? "h-8 flex-1 rounded-md border px-2 text-sm"
              : "bg-sidebar-accent border-sidebar-border h-8 flex-1 rounded-md border px-2 text-sm text-white"
          }
        >
          {DEMO_ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="bg-primary hover:bg-primary/90 h-8 rounded-md px-3 text-xs font-medium text-white transition-colors"
        >
          Switch
        </button>
      </div>
    </form>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-3 border-b px-4 py-6 sm:flex-row sm:items-end sm:justify-between sm:px-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <div className="text-muted-foreground mt-1 text-sm">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  );
}
