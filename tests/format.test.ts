import { describe, expect, it } from "vitest";
import { formatMinutes, formatShiftDate, formatTime, formatWeight, fromLondonLocalInput, toLondonLocalInput } from "@/lib/format";

describe("format", () => {
  it("formats minutes and weights", () => {
    expect(formatMinutes(450)).toBe("7h 30m");
    expect(formatMinutes(360)).toBe("6h");
    expect(formatWeight(120)).toBe("1.2×");
    expect(formatWeight(100)).toBe("1×");
    expect(formatWeight(75)).toBe("0.75×");
  });
  it("shows venue (London) time", () => {
    expect(formatTime(new Date("2026-10-23T16:00:00Z"))).toBe("17:00"); // BST
    expect(formatTime(new Date("2026-10-30T17:00:00Z"))).toBe("17:00"); // GMT
    expect(formatShiftDate("2026-10-30")).toBe("Fri 30 Oct 2026");
  });
  it("round-trips London wall-clock input across BST and GMT", () => {
    expect(fromLondonLocalInput("2026-10-23T23:30").toISOString()).toBe("2026-10-23T22:30:00.000Z");
    expect(fromLondonLocalInput("2026-10-30T23:30").toISOString()).toBe("2026-10-30T23:30:00.000Z");
    const d = new Date("2026-10-31T00:30:00Z");
    expect(fromLondonLocalInput(toLondonLocalInput(d)).getTime()).toBe(d.getTime());
  });
  it("handles the clock changes", () => {
    expect(fromLondonLocalInput("2026-10-25T01:30").toISOString()).toBe("2026-10-25T00:30:00.000Z"); // first (BST) 01:30
    expect(() => fromLondonLocalInput("2027-03-28T01:30")).toThrow(/does not exist/);
    expect(() => fromLondonLocalInput("nonsense")).toThrow();
  });
});
