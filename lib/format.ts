/** Display helpers. Venue time zone is Europe/London. Pure — safe on client and server. */
export const VENUE_TZ = "Europe/London";

export function formatMinutes(min: number): string {
  const sign = min < 0 ? "-" : "";
  const m = Math.abs(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${sign}${h}h${r ? ` ${r.toString().padStart(2, "0")}m` : ""}`;
}

/** 120 → "1.2×" (integer basis points, no float maths on money). */
export function formatWeight(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = (bp % 100).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}×`;
}

export function formatTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: VENUE_TZ, hour: "2-digit", minute: "2-digit" }).format(d);
}

export function formatDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: VENUE_TZ,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** "2026-10-30" → "Fri 30 Oct 2026" */
export function formatShiftDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" })
    .format(new Date(`${isoDate}T00:00:00Z`))
    .replace(",", "");
}

function londonParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: VENUE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Date → "YYYY-MM-DDTHH:mm" in London time, for <input type="datetime-local">. */
export function toLondonLocalInput(d: Date | null | undefined): string {
  return d ? londonParts(d) : "";
}

/**
 * "YYYY-MM-DDTHH:mm" interpreted as London wall-clock time → Date.
 * Handles BST/GMT. For the ambiguous hour when clocks go back, the first
 * (BST) occurrence is chosen; a time skipped when clocks go forward is rejected.
 */
export function fromLondonLocalInput(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error("Expected YYYY-MM-DDTHH:mm");
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  for (const offsetH of [1, 0]) {
    const candidate = new Date(asUtc - offsetH * 3600_000);
    if (londonParts(candidate) === value) return candidate;
  }
  throw new Error(`${value} does not exist in London time (clocks went forward)`);
}

/** "sam.okafor@personal.example.com" → "s********@personal.example.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 2))}@${domain}`;
}
