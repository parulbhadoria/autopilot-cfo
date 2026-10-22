import { describe, expect, it } from "vitest";
import { InMemoryLedger } from "@autopilot/guardrail";
import type { MarketSummary } from "../src/channel3/market.js";
import type { Llm } from "../src/llm/types.js";
import { MandateParseError, parseMandate } from "../src/mandate/parser.js";
import { createRuleBuyer } from "../src/negotiation/index.js";
import { PaymentStore } from "../src/payments/store.js";
import type { CreatePayoutArgs, PayoutsClient } from "../src/paypal/payouts.js";
import { defaultUnitLimitCents, runPurchase, type BuyerFactoryArgs } from "../src/pipeline/index.js";
import { Seller } from "../src/seller/seller.js";

const vendor = { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: "vendor@example.com" };
const mandateJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ weeklyBudget: 400, autoApproveUnder: 100, categories: ["flour", "sheet pans"], assumptions: [], ...over });
const llmReturning = (text: string): Llm => ({ complete: async () => text });

function setup(opts: { llmText?: string; market?: (q: string) => Promise<MarketSummary>; ledger?: InMemoryLedger } = {}) {
  const payoutCalls: CreatePayoutArgs[] = [];
  const buyerArgs: BuyerFactoryArgs[] = [];
  const payouts: PayoutsClient = {
    createPayout: async (a) => {
      payoutCalls.push(a);
      return { payoutBatchId: `B-${a.senderBatchId}`, batchStatus: "PENDING" };
    },
  };
  const deps = {
    llm: llmReturning(opts.llmText ?? mandateJson()),
    seller: new Seller({ vendor }),
    payments: { ledger: opts.ledger ?? new InMemoryLedger(), store: new PaymentStore(), payouts },
    market: opts.market,
    hardMaxWeeklyCents: 500_000,
    makeBuyer: (a: BuyerFactoryArgs) => {
      buyerArgs.push(a);
      return createRuleBuyer({ maxUnitPriceCents: a.maxUnitPriceCents });
    },
  };
  return { deps, payoutCalls, buyerArgs };
}
const OWNER = "Keep flour and sheet pans stocked, max $400/week, auto-approve under $100.";
const need = (over: Record<string, unknown> = {}) => ({ category: "sheet pans", quantity: 4, ...over });

describe("defaultUnitLimitCents", () => {
  const m = { autoApproveUnderCents: 10_000, perTransactionCapCents: 30_000 };
  const pan = { shippingCents: 0, listUnitPriceCents: 3_000 };

  it("keeps the whole order strictly under the auto-approve line when that is a realistic price", () => {
    expect(defaultUnitLimitCents(m, pan, 4)).toBe(2_499);
    expect(4 * 2_499).toBeLessThan(10_000);
  });
  it("reserves room for worst-case shipping", () => {
    expect(defaultUnitLimitCents(m, { ...pan, shippingCents: 800 }, 4)).toBe(2_299);
  });
  it("for big orders (meant for owner approval) allows up to 85% of list, capped by the per-purchase cap", () => {
    expect(defaultUnitLimitCents(m, pan, 12)).toBe(2_500); // cap 30000 / 12 = 2500 < 85% of list (2550)
    expect(defaultUnitLimitCents({ ...m, perTransactionCapCents: 100_000 }, pan, 12)).toBe(2_550);
  });
  it("never returns less than 1 cent", () => {
    expect(defaultUnitLimitCents(m, pan, 1_000_000)).toBe(1);
  });
});

describe("runPurchase: happy path", () => {
  it("parses the mandate, negotiates, passes the gate and starts the PayPal payout", async () => {
    const { deps, payoutCalls } = setup();
    const r = await runPurchase(deps, { ownerText: OWNER, need: need() });
    expect(r.outcome).toBe("payment_started");
    expect(r.product?.sku).toBe("sheet-pan-half");
    expect(r.unitLimitCents).toBe(2_499);
    expect(r.negotiation?.outcome).toBe("deal");
    expect(r.payment?.status).toBe("PROCESSING");
    expect(r.payment!.amountCents).toBeLessThan(10_000);
    expect(payoutCalls).toHaveLength(1);
    expect(payoutCalls[0]).toMatchObject({ email: "vendor@example.com", amountCents: r.payment!.amountCents, currency: "USD" });
  });

  it("the unit price never exceeds the buyer's limit", async () => {
    const { deps } = setup();
    const r = await runPurchase(deps, { ownerText: OWNER, need: need() });
    expect(r.negotiation!.deal!.unitPriceCents).toBeLessThanOrEqual(r.unitLimitCents!);
  });
});

describe("runPurchase: stops safely", () => {
  it("mandate_error on bad LLM output or a budget above the hard limit; nothing else runs", async () => {
    for (const text of ["I cannot do that", mandateJson({ weeklyBudget: 1_000_000 })]) {
      const { deps, payoutCalls, buyerArgs } = setup({ llmText: text });
      const r = await runPurchase(deps, { ownerText: OWNER, need: need() });
      expect(r.outcome).toBe("mandate_error");
      expect(r.negotiation).toBeUndefined();
      expect(buyerArgs).toHaveLength(0);
      expect(payoutCalls).toHaveLength(0);
    }
  });

  it("category_not_authorized when the owner's mandate does not include the item", async () => {
    const { deps, payoutCalls, buyerArgs } = setup({ llmText: mandateJson({ categories: ["flour"] }) });
    const r = await runPurchase(deps, { ownerText: "Keep flour stocked, max $400/week, auto-approve under $100.", need: need() });
    expect(r.outcome).toBe("category_not_authorized");
    expect(buyerArgs).toHaveLength(0);
    expect(payoutCalls).toHaveLength(0);
  });

  it("category_not_authorized for an item the vendor does not sell at all", async () => {
    const { deps, buyerArgs } = setup({ llmText: mandateJson({ categories: ["flour", "sheet pans", "diamonds"] }) });
    const r = await runPurchase(deps, { ownerText: OWNER, need: need({ category: "diamonds" }) });
    expect(r.outcome).toBe("category_not_authorized");
    expect(r.assumptions?.some((a) => /Ignored "diamonds"/.test(a))).toBe(true);
    expect(buyerArgs).toHaveLength(0);
  });

  it("no_deal when the buyer's limit is below what the seller will accept; no payment attempted", async () => {
    const { deps, payoutCalls } = setup();
    const r = await runPurchase(deps, { ownerText: OWNER, need: need({ maxUnitPriceCents: 1_500 }) });
    expect(r.outcome).toBe("no_deal");
    expect(r.negotiation?.outcome).not.toBe("deal");
    expect(r.payment).toBeUndefined();
    expect(payoutCalls).toHaveLength(0);
  });

  it("holds an over-threshold deal for owner approval; no money moves", async () => {
    const { deps, payoutCalls } = setup();
    const r = await runPurchase(deps, { ownerText: OWNER, need: need({ maxUnitPriceCents: 3_000 }) });
    expect(r.outcome).toBe("awaiting_approval");
    expect(r.payment?.status).toBe("PENDING_APPROVAL");
    expect(r.payment!.amountCents).toBeGreaterThanOrEqual(10_000);
    expect(payoutCalls).toHaveLength(0);
  });

  it("the policy gate still denies a deal the negotiation produced (weekly budget used up)", async () => {
    const ledger = new InMemoryLedger();
    ledger.add({ dealId: "earlier", vendorId: "other", amountCents: 35_000, currency: "USD", at: Date.now() });
    const { deps, payoutCalls } = setup({ ledger });
    const r = await runPurchase(deps, { ownerText: OWNER, need: need() });
    expect(r.negotiation?.outcome).toBe("deal");
    expect(r.outcome).toBe("payment_denied");
    expect(r.payment?.checks.find((c) => c.id === "weekly_budget")?.passed).toBe(false);
    expect(payoutCalls).toHaveLength(0);
  });
});

describe("runPurchase: large orders go to the owner", () => {
  it("12 pans: the buyer gets a realistic limit, closes a deal, and the order waits for approval", async () => {
    const { deps, payoutCalls } = setup();
    const r = await runPurchase(deps, { ownerText: OWNER, need: need({ quantity: 12 }) });
    expect(r.unitLimitCents).toBe(2_550); // no cap stated, so the cap defaults to the $400 weekly budget; 85% of list wins
    expect(r.negotiation?.outcome).toBe("deal");
    expect(r.outcome).toBe("awaiting_approval");
    expect(r.payment!.amountCents).toBeGreaterThanOrEqual(10_000);
    expect(r.payment!.amountCents).toBeLessThanOrEqual(30_000);
    expect(payoutCalls).toHaveLength(0);
  });
});

describe("runPurchase: market reference", () => {
  const summary = (over: Partial<MarketSummary> = {}): MarketSummary => ({
    query: "q", currency: "USD", considered: 12, count: 9, minCents: 1_800, medianCents: 3_499, maxCents: 15_999, cheapest: [], ...over,
  });

  it("records the market summary and gives the buyer a numbers-only hint", async () => {
    const { deps, buyerArgs } = setup({ market: async () => summary() });
    const r = await runPurchase(deps, { ownerText: OWNER, need: need() });
    expect(r.market?.count).toBe(9);
    expect(buyerArgs[0].businessContext).toMatch(/median 3499 cents/);
    expect(buyerArgs[0].businessContext).toMatch(/cheapest 1800 cents/);
    expect(buyerArgs[0].market).toBeDefined();
  });

  it("gives no hint when there is no comparable data", async () => {
    const { deps, buyerArgs } = setup({ market: async () => summary({ count: 0, minCents: undefined, medianCents: undefined }) });
    await runPurchase(deps, { ownerText: OWNER, need: need() });
    expect(buyerArgs[0].businessContext).not.toMatch(/Retail reference/);
  });

  it("a failing price check never blocks the purchase", async () => {
    const { deps } = setup({ market: async () => { throw new Error("Channel3 down"); } });
    const r = await runPurchase(deps, { ownerText: OWNER, need: need() });
    expect(r.market).toBeUndefined();
    expect(r.outcome).toBe("payment_started");
  });
});

describe("parseMandate with a known category vocabulary", () => {
  const opts = (text: string) => ({ llm: llmReturning(text), hardMaxWeeklyCents: 500_000, knownCategories: ["flour", "butter", "sheet pans"] });

  it("keeps known categories and drops unknown ones with an assumption", async () => {
    const { mandate, assumptions } = await parseMandate("Keep flour and gold bars stocked, $400/week", opts(mandateJson({ categories: ["Flour", "gold bars"] })));
    expect(mandate.categories).toEqual(["flour"]);
    expect(assumptions.some((a) => /Ignored "gold bars"/.test(a))).toBe(true);
  });

  it("fails when nothing the owner asked for is sold here", async () => {
    await expect(parseMandate("Keep gold bars stocked, $400/week", opts(mandateJson({ categories: ["gold bars"] })))).rejects.toThrow(MandateParseError);
  });

  it("tells the model the allowed words", async () => {
    let system = "";
    const llm: Llm = { complete: async ({ system: s }) => ((system = s), mandateJson()) };
    await parseMandate("Keep flour stocked, $400/week", { llm, hardMaxWeeklyCents: 500_000, knownCategories: ["flour", "sheet pans"] });
    expect(system).toMatch(/Allowed categories: flour, sheet pans/);
  });
});