import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMO_SHIFTS, DEMO_WORKERS, demoWorkersWithEmails } from "@/lib/db/seed-data";

describe("demo seed data", () => {
  it("uses unique ids and integer pence", () => {
    const ids = [
      ...DEMO_WORKERS.map((w) => w.id),
      ...DEMO_SHIFTS.flatMap((s) => [s.id, s.tipPool.id, ...s.assignments.map((a) => a.id)]),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of DEMO_SHIFTS) expect(Number.isSafeInteger(s.tipPool.grossPence)).toBe(true);
  });

  it("contains the Sam storyline: smaller pool and missing clock-out on 30 Oct", () => {
    const a = DEMO_SHIFTS.find((s) => s.date === "2026-10-23")!;
    const b = DEMO_SHIFTS.find((s) => s.date === "2026-10-30")!;
    expect(b.tipPool.grossPence).toBeLessThan(a.tipPool.grossPence);
    expect(b.assignments.find((x) => x.workerId === "w_sam")!.clockOut).toBeNull();
    expect(b.assignments.length).toBeGreaterThan(a.assignments.length);
  });

  it("falls back to non-allowlisted placeholder emails", () => {
    const ws = demoWorkersWithEmails(undefined);
    expect(ws.every((w) => w.paypalEmail.endsWith(".demo@personal.example.com"))).toBe(true);
    const real = demoWorkersWithEmails("s@sb.com,p@sb.com");
    expect(real[0].paypalEmail).toBe("s@sb.com");
    expect(real[2].paypalEmail).toContain(".demo@");
  });

  it("seed and reset code never imports the PayPal module", () => {
    for (const f of ["lib/db/seed.ts", "lib/db/seed-data.ts", "scripts/db-seed.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/from\s+["'][^"']*paypal/);
    }
  });
});
