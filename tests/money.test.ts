import { describe, expect, it } from "vitest";
import { decimalStringToPence, formatGBP, penceToDecimalString } from "@/lib/money";

describe("money", () => {
  it("converts pence to PayPal decimal strings without floats", () => {
    expect(penceToDecimalString(0)).toBe("0.00");
    expect(penceToDecimalString(5)).toBe("0.05");
    expect(penceToDecimalString(100)).toBe("1.00");
    expect(penceToDecimalString(64000)).toBe("640.00");
    expect(penceToDecimalString(12345)).toBe("123.45");
    expect(penceToDecimalString(-250)).toBe("-2.50");
  });

  it("parses decimal strings back to pence exactly", () => {
    expect(decimalStringToPence("1.00")).toBe(100);
    expect(decimalStringToPence("0.1")).toBe(10);
    expect(decimalStringToPence("123.45")).toBe(12345);
    expect(decimalStringToPence("7")).toBe(700);
  });

  it("round-trips classic float traps", () => {
    for (const p of [1, 10, 29, 57, 110, 999, 1005, 100_001]) {
      expect(decimalStringToPence(penceToDecimalString(p))).toBe(p);
    }
  });

  it("rejects non-integer pence and malformed strings", () => {
    expect(() => penceToDecimalString(1.5)).toThrow();
    expect(() => decimalStringToPence("1.234")).toThrow();
    expect(() => decimalStringToPence("£1")).toThrow();
  });

  it("formats GBP for display", () => {
    expect(formatGBP(64000)).toBe("£640.00");
  });
});
