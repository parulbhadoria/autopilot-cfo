import { describe, expect, it } from "vitest";
import { describeStep, outcomeInfo } from "../src/lib/purchase";
import type { TranscriptEntry } from "../src/types";

const entry = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
  negotiationId: "n", seq: 0, at: 0, round: 1, from: "buyer", type: "offer", sku: "s", quantity: 4, currency: "USD", ...over,
});

describe("describeStep", () => {
  it("turns negotiation steps into plain English with the price", () => {
    expect(describeStep(entry({ type: "offer", unitPriceCents: 1_900 }))).toBe("Your agent offers 19.00 per unit");
    expect(describeStep(entry({ from: "seller", type: "counter", unitPriceCents: 2_550 }))).toBe("Vendor counters at 25.50 per unit");
    expect(describeStep(entry({ from: "buyer", type: "accept", unitPriceCents: 2_450 }))).toBe("Your agent accepts 24.50 per unit");
    expect(describeStep(entry({ from: "seller", type: "accept", unitPriceCents: 2_450 }))).toBe("Vendor accepts at 24.50 per unit");
  });
  it("covers walk-aways, expiry and invoice rejection", () => {
    expect(describeStep(entry({ type: "walk_away" }))).toBe("Your agent walks away");
    expect(describeStep(entry({ from: "seller", type: "walk_away" }))).toBe("Vendor walks away");
    expect(describeStep(entry({ from: "seller", type: "expired" }))).toBe("Vendor's price expired");
    expect(describeStep(entry({ type: "reject" }))).toBe("Invoice did not match the agreed terms");
  });
  it("opens with the vendor's price", () => {
    expect(describeStep(entry({ from: "seller", type: "open", unitPriceCents: 3_000 }))).toBe("Vendor opens with its price");
  });
});

describe("outcomeInfo", () => {
  it("gives every known outcome a tone and a sentence", () => {
    for (const o of ["payment_started", "awaiting_approval", "payment_denied", "payment_failed", "rejected_by_owner", "invoice_mismatch", "no_deal", "category_not_authorized"]) {
      const info = outcomeInfo(o);
      expect(["ok", "warn", "bad", "info"]).toContain(info.tone);
      expect(info.text.length).toBeGreaterThan(10);
    }
  });
  it("never leaves the screen blank for an unknown outcome", () => {
    expect(outcomeInfo("something_new")).toEqual({ tone: "info", text: "something_new" });
  });
});