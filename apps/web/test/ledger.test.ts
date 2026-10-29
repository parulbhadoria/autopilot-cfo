import { describe, expect, it } from "vitest";
import { checkLabel, summarize, toCheckRows, toEventRows, toNegotiationRows } from "../src/lib/ledger";
import type { CheckResult, PaymentRecord, PurchaseRun, TranscriptEntry } from "../src/types";

const e = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
  negotiationId: "n1", seq: 0, at: 1_000, round: 0, from: "seller", type: "open", sku: "s", quantity: 4, currency: "USD", ...over,
});
const pass = (id: string): CheckResult => ({ id, passed: true, onFail: id === "approval_threshold" ? "require_approval" : "deny", message: `${id} ok` });
const fail = (id: string, message = `${id} failed`): CheckResult => ({ id, passed: false, onFail: id === "approval_threshold" ? "require_approval" : "deny", message });

const payment = (over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  paymentId: "pay_1", dealId: "d", negotiationId: "n1", vendorId: "sunrise", payeeEmail: "v@example.com", amountCents: 9_800, currency: "USD",
  status: "PROCESSING", decision: "allow", summary: "ok", checks: [pass("schema_valid"), pass("payee_matches"), pass("approval_threshold")], events: [], createdAt: 0, updatedAt: 0, ...over,
});

const dealRun = (over: Partial<PurchaseRun["result"]> = {}, id = "run_1"): PurchaseRun => ({
  runId: id,
  createdAt: 5_000,
  request: { category: "sheet pans", quantity: 4 },
  result: {
    outcome: "payment_started",
    market: { count: 13, considered: 13, medianCents: 2_799 },
    negotiation: {
      negotiationId: "n1",
      outcome: "deal",
      rounds: 3,
      transcript: [
        e({ seq: 0, from: "seller", type: "open", unitPriceCents: 3_000, totalCents: 12_000, message: "Opening price." }),
        e({ seq: 1, round: 1, from: "buyer", type: "offer", unitPriceCents: 1_900, totalCents: 7_600, reasoning: "market is lower" }),
        e({ seq: 2, round: 1, from: "seller", type: "counter", unitPriceCents: 2_550, totalCents: 10_200, message: "Best I can do" }),
        e({ seq: 3, round: 3, from: "seller", type: "accept", unitPriceCents: 2_450, totalCents: 9_800, message: "Deal" }),
      ],
    },
    payment: payment(),
    ...over,
  },
});

describe("toNegotiationRows", () => {
  it("summarises a paid deal with its savings, market median and checks", () => {
    const [row] = toNegotiationRows([dealRun()]);
    expect(row).toMatchObject({
      runId: "run_1", item: "sheet pans", quantity: 4, outcome: "payment_started", tone: "ok", rounds: 3,
      openingCents: 12_000, finalCents: 9_800, savedCents: 2_200, marketMedianCents: 2_799,
      paymentStatus: "PROCESSING", amountCents: 9_800, checksPassed: 3, checksTotal: 3, blockedBy: "",
    });
    expect(row.outcomeText).toBe("Paid automatically");
  });

  it("does not count savings for orders that were not paid", () => {
    const held = dealRun({ outcome: "awaiting_approval", payment: payment({ status: "PENDING_APPROVAL" }) });
    const denied = dealRun({ outcome: "payment_denied", payment: payment({ status: "DENIED" }) });
    const [a, b] = toNegotiationRows([held, denied]);
    expect(a.savedCents).toBeUndefined();
    expect(b.savedCents).toBeUndefined();
  });

  it("names what stopped each blocked order", () => {
    const denied = dealRun({ outcome: "payment_denied", payment: payment({ status: "DENIED", checks: [pass("schema_valid"), fail("payee_matches"), fail("approval_threshold")] }) });
    const bad = dealRun({ outcome: "invoice_mismatch", payment: undefined, negotiation: { negotiationId: "n", outcome: "invoice_mismatch", rounds: 2, transcript: [] } }, "r2");
    const cat = dealRun({ outcome: "category_not_authorized", payment: undefined, negotiation: undefined }, "r3");
    const rej = dealRun({ outcome: "rejected_by_owner", payment: payment({ status: "REJECTED" }) }, "r4");
    const rows = toNegotiationRows([denied, bad, cat, rej]);
    expect(rows.map((r) => r.blockedBy)).toEqual(["Pays the right account", "Invoice check", "Your mandate", "You"]);
  });

  it("handles runs with no negotiation or payment", () => {
    const [row] = toNegotiationRows([dealRun({ outcome: "no_deal", payment: undefined, market: undefined, negotiation: undefined })]);
    expect(row).toMatchObject({ rounds: 0, paymentStatus: "", checksTotal: 0, openingCents: undefined, savedCents: undefined, marketMedianCents: undefined });
  });

  it("ignores a market summary with no comparable listings", () => {
    const [row] = toNegotiationRows([dealRun({ market: { count: 0, considered: 13 } })]);
    expect(row.marketMedianCents).toBeUndefined();
  });
});

describe("toEventRows", () => {
  it("lists every step in order with plain actors, actions and the reasoning or message", () => {
    const rows = toEventRows(dealRun());
    expect(rows.map((r) => [r.seq, r.actor, r.action])).toEqual([
      [0, "Vendor", "Opens at"],
      [1, "Agent", "Offers"],
      [2, "Vendor", "Counters"],
      [3, "Vendor", "Accepts"],
    ]);
    expect(rows[1].note).toBe("market is lower");
    expect(rows[2].note).toBe("Best I can do");
    expect(rows[1]).toMatchObject({ unitPriceCents: 1_900, totalCents: 7_600, round: 1 });
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("labels a rejected invoice as the guardrail, not the agent", () => {
    const run = dealRun({ negotiation: { negotiationId: "n1", outcome: "invoice_mismatch", rounds: 2, transcript: [e({ seq: 4, from: "buyer", type: "reject", reasoning: "Invoice does not match" })] } });
    expect(toEventRows(run)[0]).toMatchObject({ actor: "Guardrail", action: "Rejects invoice" });
  });

  it("returns nothing when there is no run or no negotiation", () => {
    expect(toEventRows(undefined)).toEqual([]);
    expect(toEventRows(dealRun({ negotiation: undefined }))).toEqual([]);
  });
});

describe("toCheckRows", () => {
  it("translates checks into plain labels and consequences", () => {
    const rows = toCheckRows(dealRun({ payment: payment({ checks: [pass("schema_valid"), fail("weekly_budget", "Over budget"), fail("approval_threshold")] }) }));
    expect(rows).toEqual([
      { id: "schema_valid", label: "Inputs are well-formed", passed: true, severity: "Blocks the payment", message: "schema_valid ok" },
      { id: "weekly_budget", label: "Within weekly budget", passed: false, severity: "Blocks the payment", message: "Over budget" },
      { id: "approval_threshold", label: "Under auto-approve limit", passed: false, severity: "Needs your approval", message: "approval_threshold failed" },
    ]);
  });
  it("falls back to the raw id for unknown checks and handles no payment", () => {
    expect(checkLabel("brand_new_check")).toBe("brand_new_check");
    expect(toCheckRows(dealRun({ payment: undefined }))).toEqual([]);
    expect(toCheckRows(undefined)).toEqual([]);
  });
});

describe("summarize", () => {
  it("adds up paid money, savings, guardrail stops and counts", () => {
    const paid = dealRun();
    const paid2 = dealRun({ payment: payment({ amountCents: 9_650, status: "SUCCESS" }) }, "r2");
    const held = dealRun({ outcome: "awaiting_approval", payment: payment({ status: "PENDING_APPROVAL", amountCents: 29_700 }) }, "r3");
    const denied = dealRun({ outcome: "payment_denied", payment: payment({ status: "DENIED" }) }, "r4");
    const bad = dealRun({ outcome: "invoice_mismatch", payment: undefined }, "r5");
    const s = summarize(toNegotiationRows([paid, paid2, held, denied, bad]));
    expect(s).toEqual({ runs: 5, paidCents: 9_800 + 9_650, blocked: 2, savedCents: 2_200 * 2, returnedCents: 0 });
  });
  it("is all zeros for an empty ledger", () => {
    expect(summarize([])).toEqual({ runs: 0, paidCents: 0, blocked: 0, savedCents: 0, returnedCents: 0 }); 
  });
});

   describe("cancelled and refunded orders", () => {
     const reversed = (extra: Partial<PaymentRecord> = {}) =>
       dealRun({ outcome: "payment_started", payment: payment({ status: "REVERSED", payoutItemStatus: "RETURNED", ...extra }) }, "r_rev");

     it("shows the real state even though the server stored the outcome as it was at purchase time", () => {
       const [row] = toNegotiationRows([reversed()]);
       expect(row).toMatchObject({ outcome: "payment_reversed", paymentStatus: "REVERSED", payoutItemStatus: "returned", refundState: "" });
       expect(row.outcomeText).toBe("This payment was cancelled or refunded");
       expect(row.savedCents).toBeUndefined(); // money came back, so no savings are claimed
     });

     it("returned money is counted separately and not as paid out", () => {
       const rows = toNegotiationRows([dealRun(), reversed({ amountCents: 9_650 })]);
       const s = summarize(rows);
       expect(s.paidCents).toBe(9_800);
       expect(s.returnedCents).toBe(9_650);
     });

     it("shows a refund request and its confirmation", () => {
       const requested = dealRun({ payment: payment({ status: "SUCCESS", refund: { state: "REQUESTED", requestedAt: 1 } }) }, "a");
       const received = dealRun({ payment: payment({ status: "REVERSED", refund: { state: "RECEIVED", requestedAt: 1, receivedAt: 2 } }) }, "b");
       const rows = toNegotiationRows([requested, received]);
       expect(rows.map((r) => r.refundState)).toEqual(["requested", "received"]);
       expect(rows[0].paymentStatus).toBe("SUCCESS");
     });
   });