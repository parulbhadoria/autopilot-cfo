import { describe, expect, it } from "vitest";
import { dollarsInput, parseDollars, usd } from "../src/lib/format";

describe("usd", () => {
  it("formats cents as dollars", () => {
    expect(usd(9_800)).toBe("$98.00");
    expect(usd(40_000)).toBe("$400.00");
    expect(usd(5)).toBe("$0.05");
    expect(usd(123_456)).toBe("$1,234.56");
  });
  it("shows n/a for missing values", () => expect(usd(undefined)).toBe("n/a"));
});

describe("parseDollars", () => {
  it("parses plain and decorated amounts into cents", () => {
    expect(parseDollars("100")).toBe(10_000);
    expect(parseDollars("100.5")).toBe(10_050);
    expect(parseDollars(" $1,250.50 ")).toBe(125_050);
    expect(parseDollars("0.01")).toBe(1);
  });
  it("rejects anything else", () => {
    for (const bad of ["", "abc", "-5", "0", "0.00", "1.234", "1e3", "12 34", "$", "1,00,0.5x"]) expect(parseDollars(bad)).toBeNull();
  });
  it("round-trips with dollarsInput", () => {
    expect(dollarsInput(10_000)).toBe("100.00");
    expect(parseDollars(dollarsInput(4_075))).toBe(4_075);
  });
});