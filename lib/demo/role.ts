/**
 * DEMO role switcher. This is NOT authentication: anyone can choose any role.
 * It only decides which view is shown. Payment authorisation never relies on
 * it — see lib/payouts/approval.ts.
 */
import "server-only";
import { cookies } from "next/headers";
import { DEMO_WORKERS } from "../db/seed-data";

export const ROLE_COOKIE = "fs_demo_role";
export type DemoRole = { kind: "manager" } | { kind: "worker"; workerId: string; name: string };

export const DEMO_ROLES: Array<{ value: string; label: string }> = [
  { value: "manager", label: "Manager" },
  ...DEMO_WORKERS.map((w) => ({ value: w.id, label: `${w.name.split(" ")[0]} (${w.role})` })),
];

export function parseRole(value: string | undefined): DemoRole {
  const w = DEMO_WORKERS.find((x) => x.id === value);
  if (w) return { kind: "worker", workerId: w.id, name: w.name };
  return { kind: "manager" }; // default view for visitors and judges
}

export async function getDemoRole(): Promise<DemoRole> {
  return parseRole((await cookies()).get(ROLE_COOKIE)?.value);
}

export function roleValue(role: DemoRole) {
  return role.kind === "manager" ? "manager" : role.workerId;
}
