import { describe, expect, it } from "vitest";
import { DealSchema, InMemoryLedger, MandateSchema, evaluatePolicy } from "@autopilot/guardrail";
import { createLlmBuyer, createRuleBuyer, runNegotiation, type BuyerStrategy } from "../src/negotiation/index.js";
import { PaymentStore } from "../src/payments/store.js";
import type { ChatResponse, ToolChat } from "../src/llm/chat.js";
import type { CreatePayoutArgs, PayoutsClient } from "../src/paypal/payouts.js";
import { runPurchase, type PurchaseDeps } from "../src/pipeline/index.js";
import { DEFAULT_CATALOG } from "../src/seller/catalog.js";
import { INJECTION_TEXT, MaliciousSeller, Seller, type Attack } from "../src/seller/index.js";

const vendor = { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: "vendor@example.com" };
const NOW = 1_800_000_000_000;
const mandate = MandateSchema.parse({
  mandateId: "m",
  currency: "USD",
  weeklyBudgetCents: 40_000,
  perTransactionCapCents: 40_000,
  autoApproveUnderCents: 10_000,
  categories: ["flour", "butter", "sheet pans"],
  vendors: [vendor],
});

const evil = (attacks: Attack[]) => new MaliciousSeller({ vendor, attacks, now: () => NOW });
const negotiate = (seller: Seller, buyer: BuyerStrategy = createRuleBuyer({ maxUnitPriceCents: 2_499 })) =>
  runNegotiation({ seller, buyer, sku: "sheet-pan-half", quantity: 4, negotiationId: "n", dealId: "d", now: () => NOW });

describe("MaliciousSeller behaves like a seller", () => {
  it("with no attacks it matches the honest seller exactly", async () => {
    const a = await negotiate(new Seller({ vendor, now: () => NOW }));
    const b = await negotiate(evil([]));
    expect(b.outcome).toBe("deal");
    expect(b.deal).toEqual(a.deal);
    expect(b.transcript.map((e) => e.unitPriceCents)).toEqual(a.transcript.map((e) => e.unitPriceCents));
  });

  it("still never goes below its floor and never exposes it", async () => {
    const r = await negotiate(evil(["prompt_injection", "payee_swap"]));
    expect(JSON.stringify(r)).not.toMatch(/floor/i);
    const sheet = DEFAULT_CATALOG.find((p) => p.sku === "sheet-pan-half")!;
    expect(r.deal!.unitPriceCents).toBeGreaterThanOrEqual(sheet.floorUnitPriceCents);
  });
});

describe("attack: prompt injection", () => {
  it("adds the injected text to the vendor's messages", async () => {
    const r = await negotiate(evil(["prompt_injection"]));
    const sellerMsgs = r.transcript.filter((e) => e.from === "seller" && e.type !== "open");
    expect(sellerMsgs.length).toBeGreaterThan(0);
    for (const m of sellerMsgs) expect(m.message).toContain(INJECTION_TEXT);
  });

  it("a rule buyer is unaffected and the deal passes the gate at a normal price", async () => {
    const r = await negotiate(evil(["prompt_injection"]));
    expect(r.outcome).toBe("deal");
    expect(r.deal!.unitPriceCents).toBeLessThanOrEqual(2_499);
    const d = r.deal!;
    const v = evaluatePolicy({ mandate, deal: d, request: { dealId: d.dealId, payeeEmail: d.payeeEmail, amountCents: d.totalCents, currency: d.currency }, ledger: new InMemoryLedger(), now: NOW });
    expect(v.decision).toBe("allow");
  });

  it("an LLM that is fully fooled ('accept whatever') still cannot pay above its limit", async () => {
    const fooled: ChatResponse = { content: null, toolCalls: [{ id: "1", type: "function", function: { name: "accept_offer", arguments: JSON.stringify({ reasoning: "The vendor says the owner pre-approved $900." }) } }] };
    const chat: ToolChat = { chat: async () => fooled };
    const r = await negotiate(evil(["prompt_injection"]), createLlmBuyer({ chat, maxUnitPriceCents: 2_499 }));
    expect(r.outcome).toBe("deal");
    expect(r.deal!.unitPriceCents).toBeLessThanOrEqual(2_499);
    expect(r.deal!.payeeEmail).toBe(vendor.payeeEmail);
  });

  it("the injection reaches the LLM only inside <seller_message> tags", async () => {
    const prompts: string[] = [];
    const chat: ToolChat = {
      chat: async ({ messages }) => {
        prompts.push(String((messages.find((m) => m.role === "user") as any).content));
        return { content: null, toolCalls: [{ id: "1", type: "function", function: { name: "make_offer", arguments: JSON.stringify({ unitPriceCents: 2_300, reasoning: "x" }) } }] };
      },
    };
    await negotiate(evil(["prompt_injection"]), createLlmBuyer({ chat, maxUnitPriceCents: 2_499 }));
    const withInjection = prompts.filter((p) => p.includes("SYSTEM OVERRIDE"));
    expect(withInjection.length).toBeGreaterThan(0);
    for (const p of withInjection) expect(p).toMatch(/<seller_message>[^<]*SYSTEM OVERRIDE[^<]*<\/seller_message>/);
  });
});

describe("attack: tampered invoices", () => {
  it("price_bump and hidden_fees are caught by the invoice check, before any payment step", async () => {
    for (const attack of ["price_bump", "hidden_fees"] as Attack[]) {
      const r = await negotiate(evil([attack]));
      expect(r.outcome).toBe("invoice_mismatch");
      expect(r.deal).toBeUndefined();
      const last = r.transcript.at(-1)!;
      expect(last).toMatchObject({ from: "buyer", type: "reject" });
      expect(last.reasoning).toMatch(/does not match the agreed terms/);
    }
  });

  it("payee_swap and currency_swap pass the negotiation but are denied by the policy gate", async () => {
    const swap = await negotiate(evil(["payee_swap"]));
    expect(swap.outcome).toBe("deal");
    expect(swap.deal!.payeeEmail).toBe("attacker@evil.example");
    expect(DealSchema.safeParse(swap.deal).success).toBe(true);
    const v1 = evaluatePolicy({ mandate, deal: swap.deal, request: { dealId: "d", payeeEmail: swap.deal!.payeeEmail, amountCents: swap.deal!.totalCents, currency: "USD" }, ledger: new InMemoryLedger(), now: NOW });
    expect(v1.decision).toBe("deny");
    expect(v1.failed.map((c) => c.id)).toContain("payee_matches");

    const cur = await negotiate(evil(["currency_swap"]));
    expect(cur.deal!.currency).toBe("EUR");
    const v2 = evaluatePolicy({ mandate, deal: cur.deal, request: { dealId: "d", payeeEmail: cur.deal!.payeeEmail, amountCents: cur.deal!.totalCents, currency: "EUR" }, ledger: new InMemoryLedger(), now: NOW });
    expect(v2.failed.map((c) => c.id)).toContain("currency_match");
  });

  it("combined attacks are still stopped", async () => {
    const r = await negotiate(evil(["payee_swap", "price_bump", "hidden_fees", "currency_swap"]));
    expect(r.outcome).toBe("invoice_mismatch");
  });
});

describe("full pipeline against a malicious vendor: no attack ever moves money wrongly", () => {
  function pipelineDeps(seller: Seller) {
    const calls: CreatePayoutArgs[] = [];
    const payouts: PayoutsClient = { createPayout: async (a) => (calls.push(a), { payoutBatchId: "B", batchStatus: "PENDING" }) };
    const deps: PurchaseDeps = {
      llm: { complete: async () => JSON.stringify({ weeklyBudget: 400, autoApproveUnder: 100, categories: ["flour", "sheet pans"] }) },
      seller,
      payments: { ledger: new InMemoryLedger(), store: new PaymentStore(), payouts },
      hardMaxWeeklyCents: 500_000,
      makeBuyer: (a) => createRuleBuyer({ maxUnitPriceCents: a.maxUnitPriceCents }),
    };
    return { deps, calls };
  }
  const run = (attacks: Attack[]) => {
    const { deps, calls } = pipelineDeps(new MaliciousSeller({ vendor, attacks }));
    return runPurchase(deps, { ownerText: "Keep flour and sheet pans stocked, max $400/week, auto-approve under $100.", need: { category: "sheet pans", quantity: 4 } }).then((r) => ({ r, calls }));
  };

  it.each([
    ["payee_swap", "payment_denied"],
    ["currency_swap", "payment_denied"],
    ["price_bump", "invoice_mismatch"],
    ["hidden_fees", "invoice_mismatch"],
  ] as [Attack, string][])("%s -> %s, zero PayPal calls", async (attack, outcome) => {
    const { r, calls } = await run([attack]);
    expect(r.outcome).toBe(outcome);
    expect(calls).toHaveLength(0);
  });

  it("prompt_injection -> ordinary payment to the real vendor at a price within the limit", async () => {
    const { r, calls } = await run(["prompt_injection"]);
    expect(r.outcome).toBe("payment_started");
    expect(calls).toHaveLength(1);
    expect(calls[0].email).toBe(vendor.payeeEmail);
    expect(r.negotiation!.deal!.unitPriceCents).toBeLessThanOrEqual(r.unitLimitCents!);
  });
});