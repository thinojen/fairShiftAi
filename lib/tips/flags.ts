/**
 * Missing/suspicious-hours detection. Pure: returns warnings, changes nothing.
 * "error" flags block the tip calculation (the engine also enforces this);
 * "warning" flags are for the manager to review.
 */
import { formatDateTime } from "../format";
import { workedMinutes } from "./engine";

export type FlagSeverity = "error" | "warning";
export type ShiftFlag = {
  type: "missing_clock_in" | "missing_clock_out" | "long_shift" | "rota_mismatch" | "break_missing" | "not_recorded";
  severity: FlagSeverity;
  assignmentId: string;
  workerId: string | null;
  message: string;
};

export const FLAG_RULES = {
  longShiftMinutes: 14 * 60,
  rotaMismatchMinutes: 30,
  breakRequiredOverMinutes: 6 * 60,
} as const;

type A = {
  assignmentId: string;
  workerId: string | null;
  workerName?: string;
  status: "scheduled" | "worked" | "no_show" | "uncovered";
  scheduledStart: Date;
  scheduledEnd: Date;
  clockIn: Date | null;
  clockOut: Date | null;
  breakMinutes: number;
};

const mins = (a: Date, b: Date) => Math.round(Math.abs(b.getTime() - a.getTime()) / 60_000);

export function detectFlags(assignments: readonly A[]): ShiftFlag[] {
  const out: ShiftFlag[] = [];
  for (const a of assignments) {
    if (!a.workerId || a.status === "uncovered" || a.status === "no_show") continue;
    const who = a.workerName ?? a.workerId;
    const base = { assignmentId: a.assignmentId, workerId: a.workerId };

    if (a.status === "scheduled" && !a.clockIn && !a.clockOut) {
      out.push({ ...base, type: "not_recorded", severity: "error", message: `${who} has no recorded hours` });
      continue;
    }
    if (!a.clockIn) out.push({ ...base, type: "missing_clock_in", severity: "error", message: `${who} has no clock-in` });
    if (!a.clockOut) out.push({ ...base, type: "missing_clock_out", severity: "error", message: `${who} has no clock-out (rota end ${formatDateTime(a.scheduledEnd)})` });
    if (!a.clockIn || !a.clockOut) continue;

    const worked = workedMinutes(a.clockIn, a.clockOut, a.breakMinutes);
    const onSite = worked + a.breakMinutes;
    if (onSite > FLAG_RULES.longShiftMinutes) {
      out.push({ ...base, type: "long_shift", severity: "warning", message: `${who} was clocked in for over ${FLAG_RULES.longShiftMinutes / 60} hours` });
    }
    const startDiff = mins(a.scheduledStart, a.clockIn);
    const endDiff = mins(a.scheduledEnd, a.clockOut);
    if (startDiff > FLAG_RULES.rotaMismatchMinutes || endDiff > FLAG_RULES.rotaMismatchMinutes) {
      out.push({ ...base, type: "rota_mismatch", severity: "warning", message: `${who}'s clock times differ from the rota by more than ${FLAG_RULES.rotaMismatchMinutes} minutes` });
    }
    if (onSite > FLAG_RULES.breakRequiredOverMinutes && a.breakMinutes === 0) {
      out.push({ ...base, type: "break_missing", severity: "warning", message: `${who} worked over 6 hours with no recorded break` });
    }
  }
  return out;
}
