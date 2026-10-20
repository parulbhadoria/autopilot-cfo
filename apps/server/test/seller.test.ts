import { describe, expect, it } from "vitest";
import { DealSchema, InMemoryLedger, MandateSchema, evaluatePolicy } from "@autopilot/guardrail";
import { DEFAULT_CATALOG, validateCatalog, type Product } from "../src/seller/catalog.js";
import { Seller } from "../src/seller/seller.js";

const vendor = { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: "vendor@example.com" };
const NOW = 1_800_000_000_000;
const mk = (extra = {}) => new Seller({ vendor, now: () => NOW, ...extra });

describe("catalog + hidden floor", () => {
  it("never exposes the floor in the public catalog", () => {
    const pub = mk().listProducts();
    expect(pub).toHaveLength(DEFAULT_CATALOG.length);
    expect(JSON.stringify(pub)).not.toMatch(/floor/i);
    for (const p of pub) expect(Object.keys(p)).not.toContain("floorUnitPriceCents");
  });

  it("never exposes the floor through a session or its responses", () => {
    const s = mk().openNegotiation("flour-25kg", 2);
    const out = [s.respond(4_000), s.respond(4_600), s.respond(4_900)];
    expect(JSON.stringify(s)).not.toMatch(/floor/i);
    expect(JSON.stringify(out)).not.toMatch(/floor/i);
  });

  it("rejects an invalid catalog", () => {
    const bad: Product = { ...DEFAULT_CATALOG[0], floorUnitPriceCents: 9_999 };
    expect(() => validateCatalog([bad])).toThrow(/floor price is above list/);
    expect(() => validateCatalog([DEFAULT_CATALOG[0], DEFAULT_CATALOG[0]])).toThrow(/Duplicate/);
  });

  it("rejects unknown sku, bad quantity, and over-stock orders", () => {
    const s = mk();
    expect(() => s.openNegotiation("nope", 1)).toThrow(/Unknown sku/);
    expect(() => s.openNegotiation("flour-25kg", 0)).toThrow();
    expect(() => s.openNegotiation("flour-25kg", 1.5)).toThrow();
    expect(() => s.openNegotiation("flour-25kg", 9_999)).toThrow(/in stock/);
  });
});

describe("bulk discounts", () => {
  it("applies the highest qualifying tier to the opening ask", () => {
    const seller = mk();
    expect(seller.openNegotiation("flour-25kg", 2).currentAskCents).toBe(6_000);
    expect(seller.openNegotiation("flour-25kg", 5).currentAskCents).toBe(5_700);
    expect(seller.openNegotiation("flour-25kg", 10).currentAskCents).toBe(5_400);
    expect(seller.openNegotiation("flour-25kg", 20).currentAskCents).toBe(5_100);
  });

  it("never opens below the floor, even if a tier would", () => {
    const tight: Product = { ...DEFAULT_CATALOG[0], floorUnitPriceCents: 5_900, bulkTiers: [{ minQty: 2, discountPct: 50 }] };
    expect(mk({ catalog: [tight] }).openNegotiation(tight.sku, 5).currentAskCents).toBe(5_900);
  });

  it("applies free shipping over the threshold", () => {
    const s2 = mk().openNegotiation("butter-5kg", 2);
    expect(s2.priceAt(4_500)).toEqual({ subtotalCents: 9_000, shippingCents: 800, totalCents: 9_800 });
    const s3 = mk().openNegotiation("butter-5kg", 3);
    expect(s3.priceAt(4_500)).toEqual({ subtotalCents: 13_500, shippingCents: 0, totalCents: 13_500 });
  });
});

describe("negotiation", () => {
  it("plays the demo: $120 down to $98", () => {
    const s = mk().openNegotiation("flour-25kg", 2);
    expect(s.priceAt(s.currentAskCents).totalCents).toBe(12_000);

    const r1 = s.respond(4_000);
    expect(r1).toMatchObject({ action: "counter", unitPriceCents: 5_200, round: 1 });
    const r2 = s.respond(4_600);
    expect(r2).toMatchObject({ action: "counter", unitPriceCents: 4_900, round: 2 });
    const r3 = s.respond(4_900);
    expect(r3).toMatchObject({ action: "accept", unitPriceCents: 4_900, totalCents: 9_800, round: 3 });
    expect(s.closed).toBe(true);
  });

  it("accepts at its own ask when the buyer offers more than the ask", () => {
    const s = mk().openNegotiation("flour-25kg", 2);
    expect(s.respond(7_000)).toMatchObject({ action: "accept", unitPriceCents: 6_000 });
  });

  it("gives no concession to lowball offers", () => {
    const s = mk().openNegotiation("flour-25kg", 2);
    expect(s.respond(1_000)).toMatchObject({ action: "counter", unitPriceCents: 6_000 });
    expect(s.currentAskCents).toBe(6_000);
  });

  it("walks away on the final round if the offer is below the floor", () => {
    const s = mk().openNegotiation("flour-25kg", 2);
    expect(s.respond(4_000).action).toBe("counter");
    expect(s.respond(4_100).action).toBe("counter");
    expect(s.respond(4_200).action).toBe("counter");
    const last = s.respond(4_300);
    expect(last.action).toBe("reject");
    expect(s.closed).toBe(true);
    expect(s.respond(6_000)).toMatchObject({ action: "reject", message: "This negotiation is closed." });
  });

  it("takes a final-round offer at or above the floor", () => {
    const s = mk().openNegotiation("flour-25kg", 2);
    s.respond(4_000);
    s.respond(4_100);
    s.respond(4_200);
    expect(s.respond(4_500)).toMatchObject({ action: "accept", unitPriceCents: 4_500, round: 4 });
  });

  it("ignores invalid offers without using up a round", () => {
    const s = mk().openNegotiation("flour-25kg", 2);
    expect(s.respond(-5).action).toBe("reject");
    expect(s.respond(12.5).action).toBe("reject");
    expect(s.round).toBe(0);
    expect(s.closed).toBe(false);
  });

  it("invariants hold across 1000 random negotiations: never below floor, never raises its ask", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296) / 4_294_967_296);
    for (let i = 0; i < 1_000; i++) {
      const p = DEFAULT_CATALOG[Math.floor(rnd() * DEFAULT_CATALOG.length)];
      const qty = 1 + Math.floor(rnd() * 25);
      const s = mk().openNegotiation(p.sku, qty);
      let lastAsk = s.currentAskCents;
      expect(lastAsk).toBeGreaterThanOrEqual(p.floorUnitPriceCents);
      for (let r = 0; r < 6 && !s.closed; r++) {
        const offer = 1 + Math.floor(rnd() * p.listUnitPriceCents * 1.2);
        const res = s.respond(offer);
        if (res.action === "counter") {
          expect(res.unitPriceCents).toBeGreaterThanOrEqual(p.floorUnitPriceCents);
          expect(res.unitPriceCents).toBeGreaterThan(offer);
          expect(res.unitPriceCents).toBeLessThanOrEqual(lastAsk);
          lastAsk = res.unitPriceCents;
        } else if (res.action === "accept") {
          expect(res.unitPriceCents).toBeGreaterThanOrEqual(p.floorUnitPriceCents);
          expect(s.closed).toBe(true);
        }
      }
    }
  });
});

describe("handoff to the guardrail", () => {
  const mandate = MandateSchema.parse({
    mandateId: "m1",
    currency: "USD",
    weeklyBudgetCents: 40_000,
    perTransactionCapCents: 30_000,
    autoApproveUnderCents: 10_000,
    categories: ["flour", "butter"],
    vendors: [vendor],
  });

  it("refuses to make a deal before one is agreed", () => {
    const s = mk().openNegotiation("flour-25kg", 2);
    expect(() => s.toDeal({ dealId: "d", negotiationId: "n" })).toThrow(/No agreed price/);
  });

  it("produces a valid deal that the policy engine auto-approves", () => {
    const s = mk().openNegotiation("flour-25kg", 2);
    s.respond(4_000);
    s.respond(4_600);
    s.respond(4_900);
    const deal = s.toDeal({ dealId: "deal-1", negotiationId: "neg-1" });
    expect(DealSchema.safeParse(deal).success).toBe(true);
    expect(deal.expiresAt).toBe(NOW + 10 * 60_000);
    const result = evaluatePolicy({
      mandate,
      deal,
      request: { dealId: deal.dealId, payeeEmail: deal.payeeEmail, amountCents: deal.totalCents, currency: deal.currency },
      ledger: new InMemoryLedger(),
      now: NOW,
    });
    expect(deal.totalCents).toBe(9_800);
    expect(result.decision).toBe("allow");
  });
});