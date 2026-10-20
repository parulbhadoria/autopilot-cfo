import { describe, expect, it } from "vitest";
import { MandateParseError, parseMandate } from "../src/mandate/parser.js";
import type { Llm } from "../src/llm/types.js";

const llmReturning = (text: string): Llm => ({ complete: async () => text });
const opts = (text: string, hard = 500_000) => ({ llm: llmReturning(text), hardMaxWeeklyCents: hard });

const good = JSON.stringify({
  currency: "USD",
  weeklyBudget: 400,
  autoApproveUnder: 50,
  categories: ["Flour", "butter"],
  assumptions: [],
});

describe("parseMandate", () => {
  it("converts dollars to integer cents and lowercases categories", async () => {
    const { mandate, assumptions } = await parseMandate("Keep flour and butter stocked, max $400/week", opts(good));
    expect(mandate.weeklyBudgetCents).toBe(40_000);
    expect(mandate.autoApproveUnderCents).toBe(5_000);
    expect(mandate.categories).toEqual(["flour", "butter"]);
    expect(mandate.perTransactionCapCents).toBe(40_000);
    expect(assumptions.join(" ")).toMatch(/No per-purchase cap/);
  });

  it("accepts JSON wrapped in markdown fences or prose", async () => {
    const { mandate } = await parseMandate("some owner text", opts("Here you go:\n```json\n" + good + "\n```"));
    expect(mandate.weeklyBudgetCents).toBe(40_000);
  });

  it("tightens (never loosens) contradictory limits and says so", async () => {
    const bad = JSON.stringify({ weeklyBudget: 400, autoApproveUnder: 300, perTransactionCap: 100, categories: ["flour"] });
    const { mandate, assumptions } = await parseMandate("some owner text", opts(bad));
    expect(mandate.autoApproveUnderCents).toBe(10_000);
    expect(assumptions.some((a) => /lowered/.test(a))).toBe(true);
  });

  it("rejects a budget above the code-level hard limit", async () => {
    const huge = JSON.stringify({ weeklyBudget: 1_000_000, autoApproveUnder: 50, categories: ["flour"] });
    await expect(parseMandate("some owner text", opts(huge))).rejects.toThrow(/hard limit/);
  });

  it("rejects non-JSON, invalid JSON, and wrong-shape output", async () => {
    await expect(parseMandate("some owner text", opts("I cannot do that."))).rejects.toThrow(MandateParseError);
    await expect(parseMandate("some owner text", opts("{not json}"))).rejects.toThrow(MandateParseError);
    await expect(parseMandate("some owner text", opts('{"weeklyBudget": -5}'))).rejects.toThrow(MandateParseError);
  });

  it("rejects empty or oversized instructions without calling the LLM", async () => {
    let called = false;
    const llm: Llm = { complete: async () => ((called = true), good) };
    await expect(parseMandate("hi", { llm, hardMaxWeeklyCents: 1 })).rejects.toThrow(MandateParseError);
    await expect(parseMandate("x".repeat(1001), { llm, hardMaxWeeklyCents: 1 })).rejects.toThrow(MandateParseError);
    expect(called).toBe(false);
  });
});
