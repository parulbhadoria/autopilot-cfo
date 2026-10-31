import { describe, expect, it } from "vitest";
import { describeEvent, describeStep, effectiveOutcome, outcomeInfo } from "../src/lib/purchase";
import type { PaymentRecord, PurchaseResult, TranscriptEntry } from "../src/types";

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

   describe("effectiveOutcome", () => {
     const withStatus = (status: PaymentRecord["status"] | undefined, outcome = "payment_started"): PurchaseResult => ({
       outcome,
       payment: status ? ({ status } as PaymentRecord) : undefined,
     });

     it("follows the payment's real status, not the outcome stored when the order was placed", () => {
       expect(effectiveOutcome(withStatus("PROCESSING"))).toBe("payment_started");
       expect(effectiveOutcome(withStatus("SUCCESS"))).toBe("payment_started");
       expect(effectiveOutcome(withStatus("PENDING_APPROVAL", "awaiting_approval"))).toBe("awaiting_approval");
       expect(effectiveOutcome(withStatus("REJECTED"))).toBe("rejected_by_owner");
       expect(effectiveOutcome(withStatus("DENIED"))).toBe("payment_denied");
       expect(effectiveOutcome(withStatus("FAILED"))).toBe("payment_failed");
       expect(effectiveOutcome(withStatus("REVERSED"))).toBe("payment_reversed");
       expect(effectiveOutcome(withStatus("UNKNOWN"))).toBe("payment_unknown");
     });

     it("uses the stored outcome when there is no payment", () => {
       expect(effectiveOutcome(withStatus(undefined, "no_deal"))).toBe("no_deal");
       expect(effectiveOutcome(withStatus(undefined, "invoice_mismatch"))).toBe("invoice_mismatch");
     });

     it("every outcome it can return has text for the owner", () => {
       for (const s of ["PROCESSING", "PENDING_APPROVAL", "REJECTED", "DENIED", "FAILED", "REVERSED", "UNKNOWN"] as const) {
         expect(outcomeInfo(effectiveOutcome(withStatus(s))).text.length).toBeGreaterThan(10);
       }
     });
   });


describe("describeEvent", () => {
  it("puts our own events in plain English", () => {
    expect(describeEvent({ type: "policy_evaluated", detail: "All policy checks passed." })).toEqual({ label: "Your rules were checked", detail: "All policy checks passed.", viaWebhook: false });
    expect(describeEvent({ type: "payout_cancelled" }).label).toMatch(/money returned/i);
    expect(describeEvent({ type: "refund_requested" }).label).toMatch(/requested from the vendor/i);
  });

  it("marks what PayPal pushed to us, with a readable label", () => {
    const e = describeEvent({ type: "webhook:PAYMENT.PAYOUTS-ITEM.SUCCEEDED" });
    expect(e).toMatchObject({ label: "PayPal confirmed the payment was delivered", viaWebhook: true });
    expect(describeEvent({ type: "webhook:PAYMENT.PAYOUTS-ITEM.UNCLAIMED" }).label).toMatch(/has not claimed/i);
    expect(describeEvent({ type: "webhook:PAYMENT.PAYOUTS-ITEM.RETURNED" }).label).toMatch(/returned the money/i);
  });

  it("never shows a blank or crashes on an event it does not know", () => {
    expect(describeEvent({ type: "something_new" })).toEqual({ label: "something_new", detail: undefined, viaWebhook: false });
    expect(describeEvent({ type: "webhook:PAYMENT.NEW.THING" })).toMatchObject({ label: "PayPal event: PAYMENT.NEW.THING", viaWebhook: true });
  });
});