/**
 * Synthetic demo data — every person, venue and amount here is fictional.
 *
 * This module is PURE (no DB, no network) so it can be unit-tested and reused by
 * the "Reset demo" action. It never creates allocations or payouts: those only
 * come from the tip engine + a manager-approved PayPal payout, so the seed can
 * never fabricate a payment.
 *
 * Built-in story (SPEC §9): Sam (bartender) earns less on Fri 30 Oct than on
 * Fri 23 Oct — fewer logged hours (missing clock-out), a smaller pool, and an
 * extra runner on shift. Policy v2 (host weight 0.6 → 0.7) takes effect 26 Oct.
 */
import type { TipPolicyRules } from "./schema";

export const DEMO_VENUE_ID = "v_copper_lantern";

/** Order matters: maps 1:1 onto PAYPAL_SANDBOX_RECIPIENTS when provided. */
export const DEMO_WORKERS = [
  { id: "w_sam", name: "Sam Okafor", role: "bartender", hourlyRatePence: 1250 },
  { id: "w_priya", name: "Priya Nair", role: "server", hourlyRatePence: 1221 },
  { id: "w_jordan", name: "Jordan Lee", role: "runner", hourlyRatePence: 1221 },
  { id: "w_alex", name: "Alex Moreno", role: "host", hourlyRatePence: 1221 },
  { id: "w_casey", name: "Casey Byrne", role: "runner", hourlyRatePence: 1221 },
] as const;

/** Placeholder emails are NOT allowlisted, so payouts to them are refused. */
export function placeholderEmail(workerId: string) {
  return `${workerId.replace("w_", "")}.demo@personal.example.com`;
}

const baseRules: TipPolicyRules = {
  method: "minutes_x_weight",
  weightsBp: { bartender: 120, server: 100, runner: 80, host: 60, kitchen: 60 },
  minMinutesToQualify: 120,
  rounding: "largest_remainder",
};

export const DEMO_POLICIES = [
  {
    id: "pol_v1",
    version: 1,
    effectiveFrom: "2026-10-01",
    rules: baseRules,
    textSummary:
      "Card tips from each service are pooled and shared by minutes worked × role weight " +
      "(bartender 1.2, server 1.0, runner 0.8, host 0.6, kitchen 0.6). Staff must work at " +
      "least 2 hours to qualify. Leftover pennies go to the largest remainders.",
  },
  {
    id: "pol_v2",
    version: 2,
    effectiveFrom: "2026-10-26",
    rules: { ...baseRules, weightsBp: { ...baseRules.weightsBp, host: 70 } },
    textSummary:
      "As v1, but after staff consultation the host weight rises from 0.6 to 0.7. " +
      "All other weights and the 2-hour minimum are unchanged.",
  },
] as const;

type Assignment = {
  id: string;
  workerId: string | null;
  role: (typeof DEMO_WORKERS)[number]["role"];
  scheduledStart: string;
  scheduledEnd: string;
  clockIn: string | null;
  clockOut: string | null;
  breakMinutes: number;
  status: "scheduled" | "worked" | "no_show" | "uncovered";
};

type DemoShift = {
  id: string;
  date: string;
  service: "lunch" | "dinner" | "late";
  status: "open" | "closed";
  tipPool: { id: string; grossPence: number; source: "card" };
  assignments: Assignment[];
};

// 23–24 Oct are BST (+01:00); clocks go back 25 Oct, so 30–31 Oct are GMT (Z).
const w = (
  id: string,
  workerId: string,
  role: Assignment["role"],
  start: string,
  end: string,
  clockIn: string | null,
  clockOut: string | null,
  breakMinutes = 30,
): Assignment => ({
  id,
  workerId,
  role,
  scheduledStart: start,
  scheduledEnd: end,
  clockIn,
  clockOut,
  breakMinutes,
  status: "worked",
});

export const DEMO_SHIFTS: DemoShift[] = [
  {
    id: "sh_2026-10-23_dinner",
    date: "2026-10-23",
    service: "dinner",
    status: "closed",
    tipPool: { id: "tp_2026-10-23_dinner", grossPence: 64000, source: "card" },
    assignments: [
      w("sa_1023_sam", "w_sam", "bartender", "2026-10-23T17:00:00+01:00", "2026-10-24T01:00:00+01:00", "2026-10-23T17:00:00+01:00", "2026-10-24T01:00:00+01:00"),
      w("sa_1023_priya", "w_priya", "server", "2026-10-23T17:00:00+01:00", "2026-10-23T23:30:00+01:00", "2026-10-23T16:55:00+01:00", "2026-10-23T23:35:00+01:00"),
      w("sa_1023_jordan", "w_jordan", "runner", "2026-10-23T18:00:00+01:00", "2026-10-23T23:00:00+01:00", "2026-10-23T18:00:00+01:00", "2026-10-23T23:00:00+01:00"),
      w("sa_1023_alex", "w_alex", "host", "2026-10-23T17:30:00+01:00", "2026-10-23T22:30:00+01:00", "2026-10-23T17:30:00+01:00", "2026-10-23T22:30:00+01:00", 15),
    ],
  },
  {
    id: "sh_2026-10-24_dinner",
    date: "2026-10-24",
    service: "dinner",
    status: "closed",
    tipPool: { id: "tp_2026-10-24_dinner", grossPence: 71250, source: "card" },
    assignments: [
      w("sa_1024_sam", "w_sam", "bartender", "2026-10-24T17:00:00+01:00", "2026-10-25T01:00:00+01:00", "2026-10-24T17:00:00+01:00", "2026-10-25T01:10:00+01:00"),
      w("sa_1024_priya", "w_priya", "server", "2026-10-24T17:00:00+01:00", "2026-10-24T23:30:00+01:00", "2026-10-24T17:00:00+01:00", "2026-10-24T23:30:00+01:00"),
      w("sa_1024_casey", "w_casey", "runner", "2026-10-24T18:00:00+01:00", "2026-10-24T23:00:00+01:00", "2026-10-24T18:05:00+01:00", "2026-10-24T23:00:00+01:00"),
      w("sa_1024_alex", "w_alex", "host", "2026-10-24T17:30:00+01:00", "2026-10-24T22:30:00+01:00", "2026-10-24T17:30:00+01:00", "2026-10-24T22:30:00+01:00", 15),
    ],
  },
  {
    // The story shift: smaller pool, extra runner, Sam's clock-out missing.
    id: "sh_2026-10-30_dinner",
    date: "2026-10-30",
    service: "dinner",
    status: "open",
    tipPool: { id: "tp_2026-10-30_dinner", grossPence: 51000, source: "card" },
    assignments: [
      w("sa_1030_sam", "w_sam", "bartender", "2026-10-30T17:00:00Z", "2026-10-30T23:30:00Z", "2026-10-30T17:00:00Z", null),
      w("sa_1030_priya", "w_priya", "server", "2026-10-30T17:00:00Z", "2026-10-30T23:30:00Z", "2026-10-30T17:00:00Z", "2026-10-30T23:30:00Z"),
      w("sa_1030_jordan", "w_jordan", "runner", "2026-10-30T18:00:00Z", "2026-10-30T23:00:00Z", "2026-10-30T18:00:00Z", "2026-10-30T23:00:00Z"),
      w("sa_1030_casey", "w_casey", "runner", "2026-10-30T18:00:00Z", "2026-10-30T23:00:00Z", "2026-10-30T18:00:00Z", "2026-10-30T23:00:00Z"),
      w("sa_1030_alex", "w_alex", "host", "2026-10-30T17:30:00Z", "2026-10-30T22:30:00Z", "2026-10-30T17:30:00Z", "2026-10-30T22:30:00Z", 15),
    ],
  },
  {
    // Upcoming shift with an uncovered runner slot (for shift-cover later).
    id: "sh_2026-11-06_dinner",
    date: "2026-11-06",
    service: "dinner",
    status: "open",
    tipPool: { id: "tp_2026-11-06_dinner", grossPence: 0, source: "card" },
    assignments: [
      { ...w("sa_1106_sam", "w_sam", "bartender", "2026-11-06T17:00:00Z", "2026-11-07T01:00:00Z", null, null), status: "scheduled" },
      { ...w("sa_1106_priya", "w_priya", "server", "2026-11-06T17:00:00Z", "2026-11-06T23:30:00Z", null, null), status: "scheduled" },
      {
        id: "sa_1106_runner",
        workerId: null,
        role: "runner",
        scheduledStart: "2026-11-06T18:00:00Z",
        scheduledEnd: "2026-11-06T23:00:00Z",
        clockIn: null,
        clockOut: null,
        breakMinutes: 0,
        status: "uncovered",
      },
    ],
  },
];

/**
 * Resolve each worker's PayPal email. Real sandbox recipients come from the
 * comma-separated PAYPAL_SANDBOX_RECIPIENTS allowlist (in DEMO_WORKERS order);
 * otherwise a non-allowlisted placeholder is used.
 */
export function demoWorkersWithEmails(recipientsCsv: string | undefined) {
  const emails = (recipientsCsv ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  return DEMO_WORKERS.map((wk, i) => ({
    ...wk,
    venueId: DEMO_VENUE_ID,
    paypalEmail: emails[i] ?? placeholderEmail(wk.id),
  }));
}
