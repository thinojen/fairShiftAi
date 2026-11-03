import { describe, expect, it } from "vitest";
import { DEMO_POLICIES, DEMO_SHIFTS } from "@/lib/db/seed-data";
import { allocateTips, workedMinutes, type EngineAssignment, type EnginePolicy } from "@/lib/tips/engine";
import { detectFlags } from "@/lib/tips/flags";
import { policyForDate } from "@/lib/tips/policy";

const v1: EnginePolicy = { id: "pol_v1", version: 1, rules: DEMO_POLICIES[0].rules };
const v2: EnginePolicy = { id: "pol_v2", version: 2, rules: DEMO_POLICIES[1].rules };

const T = (iso: string) => new Date(iso);
const worker = (over: Partial<EngineAssignment> & { workerId: string }): EngineAssignment => ({
  assignmentId: `sa_${over.workerId}`,
  role: "server",
  status: "worked",
  clockIn: T("2026-10-30T17:00:00Z"),
  clockOut: T("2026-10-30T23:00:00Z"),
  breakMinutes: 0,
  ...over,
});

function seedShift(date: string) {
  const s = DEMO_SHIFTS.find((x) => x.date === date)!;
  return {
    grossPence: s.tipPool.grossPence,
    assignments: s.assignments.map(
      (a): EngineAssignment => ({
        assignmentId: a.id,
        workerId: a.workerId,
        role: a.role,
        status: a.status,
        clockIn: a.clockIn ? T(a.clockIn) : null,
        clockOut: a.clockOut ? T(a.clockOut) : null,
        breakMinutes: a.breakMinutes,
      }),
    ),
  };
}

const shareOf = (r: ReturnType<typeof allocateTips>, id: string) => {
  if (!r.ok) throw new Error("expected ok");
  return r.workers.find((w) => w.workerId === id)!.sharePence;
};

describe("workedMinutes", () => {
  it("subtracts break and ignores seconds", () => {
    expect(workedMinutes(T("2026-10-30T17:00:00Z"), T("2026-10-30T23:30:59Z"), 30)).toBe(360);
  });
  it("works across midnight and the BST→GMT change", () => {
    // 25 Oct 2026: clocks go back at 02:00 BST. 23:00 BST → 03:00 GMT = 5 real hours.
    expect(workedMinutes(T("2026-10-24T23:00:00+01:00"), T("2026-10-25T03:00:00Z"), 0)).toBe(300);
  });
});

describe("allocateTips — Sam storyline (SPEC §9)", () => {
  it("Fri 23 Oct under policy v1: Sam gets £266.46", () => {
    const r = allocateTips({ ...seedShift("2026-10-23"), policy: v1 });
    expect(r.ok).toBe(true);
    expect(shareOf(r, "w_sam")).toBe(26646);
    if (r.ok) {
      expect(r.allocatedPence).toBe(64000);
      expect(r.policy).toEqual({ id: "pol_v1", version: 1 });
      const sam = r.workers.find((w) => w.workerId === "w_sam")!;
      expect(sam).toMatchObject({ workedMinutes: 450, weightBp: 120, points: 54000 });
    }
  });

  it("Fri 30 Oct is BLOCKED while Sam's clock-out is missing", () => {
    const r = allocateTips({ ...seedShift("2026-10-30"), policy: v2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blockers).toHaveLength(1);
      expect(r.blockers[0]).toMatchObject({ code: "missing_clock_out", workerId: "w_sam" });
    }
  });

  it("Fri 30 Oct after the clock-out is fixed to the scheduled end: Sam gets £154.77", () => {
    const shift = seedShift("2026-10-30");
    const sam = shift.assignments.find((a) => a.workerId === "w_sam")!;
    sam.clockOut = T("2026-10-30T23:30:00Z");
    const r = allocateTips({ ...shift, policy: v2 });
    expect(shareOf(r, "w_sam")).toBe(15477);
    if (r.ok) expect(r.allocatedPence).toBe(51000);
  });

  it("uses each shift's own policy version (host 0.6 → 0.7)", () => {
    const a = allocateTips({ ...seedShift("2026-10-23"), policy: v1 });
    const shift = seedShift("2026-10-30");
    shift.assignments.find((x) => x.workerId === "w_sam")!.clockOut = T("2026-10-30T23:30:00Z");
    const b = allocateTips({ ...shift, policy: v2 });
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.workers.find((w) => w.workerId === "w_alex")!.weightBp).toBe(60);
    expect(b.workers.find((w) => w.workerId === "w_alex")!.weightBp).toBe(70);
  });
});

describe("allocateTips — rounding", () => {
  it("splits 100p three ways as 34/33/33 with ties broken by worker id", () => {
    const r = allocateTips({
      grossPence: 100,
      policy: v1,
      assignments: [worker({ workerId: "c" }), worker({ workerId: "a" }), worker({ workerId: "b" })],
    });
    if (!r.ok) throw new Error();
    expect(r.workers.map((w) => [w.workerId, w.sharePence])).toEqual([["a", 34], ["b", 33], ["c", 33]]);
    expect(r.workers.find((w) => w.workerId === "a")!.remainderPence).toBe(1);
  });

  it("gives leftover pennies to the largest remainders, not by order", () => {
    // points 2:1 → 1000p × 2/3 = 666.67, × 1/3 = 333.33 → 667 / 333
    const r = allocateTips({
      grossPence: 1000,
      policy: v1,
      assignments: [
        worker({ workerId: "a", role: "server", clockOut: T("2026-10-30T20:00:00Z") }), // 180 × 100
        worker({ workerId: "b", role: "server" }), // 360 × 100
      ],
    });
    expect(shareOf(r, "b")).toBe(667);
    expect(shareOf(r, "a")).toBe(333);
  });

  it("always sums exactly to the pool (randomised)", () => {
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const roles = ["bartender", "server", "runner", "host", "kitchen"] as const;
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + rand(12);
      const assignments = Array.from({ length: n }, (_, i) =>
        worker({
          workerId: `w${i}`,
          role: roles[rand(5)],
          clockIn: T("2026-10-30T12:00:00Z"),
          clockOut: new Date(T("2026-10-30T12:00:00Z").getTime() + (130 + rand(700)) * 60_000),
          breakMinutes: rand(10),
        }),
      );
      const gross = rand(500_000);
      const r = allocateTips({ grossPence: gross, policy: v2, assignments });
      if (!r.ok) throw new Error(JSON.stringify(r.blockers));
      expect(r.workers.reduce((s, w) => s + w.sharePence, 0)).toBe(gross);
      for (const w of r.workers) expect(Number.isSafeInteger(w.sharePence) && w.sharePence >= 0).toBe(true);
    }
  });

  it("stays exact for very large pools (BigInt intermediates)", () => {
    const gross = Number.MAX_SAFE_INTEGER - 1;
    const r = allocateTips({ grossPence: gross, policy: v1, assignments: [worker({ workerId: "a" }), worker({ workerId: "b", role: "bartender" })] });
    if (!r.ok) throw new Error();
    expect(r.workers.reduce((s, w) => s + w.sharePence, 0)).toBe(gross);
  });

  it("is deterministic regardless of input order", () => {
    const xs = [worker({ workerId: "a" }), worker({ workerId: "b", role: "runner" }), worker({ workerId: "c", role: "host" })];
    const r1 = allocateTips({ grossPence: 10001, policy: v1, assignments: xs });
    const r2 = allocateTips({ grossPence: 10001, policy: v1, assignments: [...xs].reverse() });
    expect(r1).toEqual(r2);
  });
});

describe("allocateTips — eligibility and edge cases", () => {
  it("excludes workers under the minimum and no-shows, with reasons", () => {
    const r = allocateTips({
      grossPence: 1000,
      policy: v1,
      assignments: [
        worker({ workerId: "a" }),
        worker({ workerId: "short", clockOut: T("2026-10-30T18:30:00Z") }), // 90 min < 120
        worker({ workerId: "ns", status: "no_show", clockIn: null, clockOut: null }),
      ],
    });
    if (!r.ok) throw new Error();
    expect(shareOf(r, "a")).toBe(1000);
    expect(r.workers.find((w) => w.workerId === "short")).toMatchObject({ eligible: false, sharePence: 0, points: 0 });
    expect(r.workers.find((w) => w.workerId === "ns")!.excludedReason).toBe("No-show");
  });

  it("qualifies at exactly the minimum", () => {
    const r = allocateTips({ grossPence: 500, policy: v1, assignments: [worker({ workerId: "a", clockOut: T("2026-10-30T19:00:00Z") })] });
    expect(shareOf(r, "a")).toBe(500);
  });

  it("ignores uncovered slots", () => {
    const r = allocateTips({
      grossPence: 500,
      policy: v1,
      assignments: [worker({ workerId: "a" }), { ...worker({ workerId: "x" }), workerId: null, status: "uncovered" }],
    });
    if (!r.ok) throw new Error();
    expect(r.workers).toHaveLength(1);
  });

  it("allows a £0 pool (everyone gets 0)", () => {
    const r = allocateTips({ grossPence: 0, policy: v1, assignments: [worker({ workerId: "a" })] });
    expect(shareOf(r, "a")).toBe(0);
  });

  it("allows an empty shift with a £0 pool", () => {
    const r = allocateTips({ grossPence: 0, policy: v1, assignments: [] });
    expect(r.ok).toBe(true);
  });
});

describe("allocateTips — blockers (nothing is calculated)", () => {
  const block = (assignments: EngineAssignment[], grossPence = 1000) => {
    const r = allocateTips({ grossPence, policy: v1, assignments });
    if (r.ok) throw new Error("expected blocked");
    return r.blockers.map((b) => b.code);
  };
  it("missing clock-in / clock-out", () => {
    expect(block([worker({ workerId: "a", clockIn: null })])).toEqual(["missing_clock_in"]);
    expect(block([worker({ workerId: "a", clockOut: null })])).toEqual(["missing_clock_out"]);
  });
  it("unrecorded scheduled worker", () => {
    expect(block([worker({ workerId: "a", status: "scheduled", clockIn: null, clockOut: null })])).toEqual(["not_recorded"]);
  });
  it("clock-out before clock-in, and break longer than the shift", () => {
    expect(block([worker({ workerId: "a", clockOut: T("2026-10-30T16:00:00Z") })])).toEqual(["clock_out_before_clock_in"]);
    expect(block([worker({ workerId: "a", breakMinutes: 360 })])).toEqual(["break_exceeds_shift"]);
    expect(block([worker({ workerId: "a", breakMinutes: -5 })])).toEqual(["invalid_break"]);
  });
  it("invalid pool, duplicate worker, nobody eligible", () => {
    expect(block([worker({ workerId: "a" })], -1)).toContain("invalid_pool");
    expect(block([worker({ workerId: "a" })], 1.5)).toContain("invalid_pool");
    expect(block([worker({ workerId: "a" }), worker({ workerId: "a", assignmentId: "x" })])).toEqual(["duplicate_worker"]);
    expect(block([worker({ workerId: "a", clockOut: T("2026-10-30T18:00:00Z") })])).toEqual(["no_eligible_workers"]);
  });
  it("reports every blocker at once", () => {
    expect(block([worker({ workerId: "a", clockIn: null }), worker({ workerId: "b", clockOut: null })])).toEqual(["missing_clock_in", "missing_clock_out"]);
  });
});

describe("policyForDate", () => {
  const policies = DEMO_POLICIES.map((p) => ({ id: p.id, version: p.version, effectiveFrom: p.effectiveFrom }));
  it("picks the version in force on the shift date", () => {
    expect(policyForDate(policies, "2026-10-23")!.version).toBe(1);
    expect(policyForDate(policies, "2026-10-25")!.version).toBe(1);
    expect(policyForDate(policies, "2026-10-26")!.version).toBe(2);
    expect(policyForDate(policies, "2026-10-30")!.version).toBe(2);
  });
  it("returns null before any policy exists", () => {
    expect(policyForDate(policies, "2026-09-30")).toBeNull();
  });
});

describe("detectFlags", () => {
  const base = {
    assignmentId: "sa",
    workerId: "w",
    status: "worked" as const,
    scheduledStart: T("2026-10-30T17:00:00Z"),
    scheduledEnd: T("2026-10-30T23:00:00Z"),
    clockIn: T("2026-10-30T17:00:00Z") as Date | null,
    clockOut: T("2026-10-30T23:00:00Z") as Date | null,
    breakMinutes: 30,
  };
  it("flags the seeded Sam clock-out as an error", () => {
    const s = DEMO_SHIFTS.find((x) => x.date === "2026-10-30")!;
    const flags = detectFlags(
      s.assignments.map((a) => ({
        assignmentId: a.id,
        workerId: a.workerId,
        status: a.status,
        scheduledStart: T(a.scheduledStart),
        scheduledEnd: T(a.scheduledEnd),
        clockIn: a.clockIn ? T(a.clockIn) : null,
        clockOut: a.clockOut ? T(a.clockOut) : null,
        breakMinutes: a.breakMinutes,
      })),
    );
    expect(flags).toEqual([expect.objectContaining({ type: "missing_clock_out", severity: "error", workerId: "w_sam" })]);
  });
  it("is clean for a normal shift", () => {
    expect(detectFlags([base])).toEqual([]);
  });
  it("warns on rota mismatch, long shifts and missing breaks", () => {
    const types = (o: Partial<typeof base>) => detectFlags([{ ...base, ...o }]).map((f) => f.type);
    expect(types({ clockOut: T("2026-10-30T23:45:00Z") })).toEqual(["rota_mismatch"]);
    expect(types({ clockOut: T("2026-10-31T08:00:00Z") })).toContain("long_shift");
    expect(types({ breakMinutes: 0, clockOut: T("2026-10-30T23:20:00Z") })).toEqual(["break_missing"]);
  });
});
