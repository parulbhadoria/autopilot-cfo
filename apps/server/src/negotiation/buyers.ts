import type { PublicProduct } from "../seller/catalog.js";
import type { BuyerDecision, TranscriptEntry } from "./messages.js";

export interface BuyerContext {
  negotiationId: string;
  sku: string;
  quantity: number;
  currency: string;
  /** 1-based number of the buyer message being decided now. */
  round: number;
  maxRounds: number;
  /** Public listing for the product (never contains the seller's floor). */
  product: PublicProduct;
  /** The seller's current ask. */
  sellerAsk: { unitPriceCents: number; shippingCents: number; totalCents: number; expiresAt: number };
  /** Copy of the transcript so far. */
  history: TranscriptEntry[];
}

export interface BuyerStrategy {
  /** May return anything; the loop validates it against BuyerDecisionSchema and fails closed. */
  decide(ctx: BuyerContext): Promise<unknown> | unknown;
}

export interface RuleBuyerOptions {
  /** The buyer will never offer or accept above this unit price. */
  maxUnitPriceCents: number;
  /** First offer as a fraction of the seller's opening ask. */
  openingFraction?: number;
  /** Walk away only after this many rounds... */
  walkAwayAfterRound?: number;
  /** ...and only if the ask is still more than this % above the limit. */
  walkAwayAboveMaxPct?: number;
}

/** A simple deterministic buyer used for tests and the demo. Day 10 adds an LLM buyer with the same interface. */
export function createRuleBuyer(o: RuleBuyerOptions): BuyerStrategy {
  const max = o.maxUnitPriceCents;
  const opening = o.openingFraction ?? 2 / 3;
  const walkAfter = o.walkAwayAfterRound ?? 3;
  const walkPct = o.walkAwayAboveMaxPct ?? 15;

  return {
    decide(ctx): BuyerDecision {
      const ask = ctx.sellerAsk.unitPriceCents;
      if (ask <= max) {
        return { type: "accept", reasoning: `Ask ${ask} is within my limit of ${max} per unit.` };
      }
      if (ctx.round > walkAfter && ask * 100 > max * (100 + walkPct)) {
        return { type: "walk_away", reasoning: `Ask ${ask} is still too far above my limit of ${max} after ${ctx.round - 1} rounds.` };
      }
      const buyerOffers = ctx.history.filter((e) => e.from === "buyer" && e.type === "offer");
      const last = buyerOffers[buyerOffers.length - 1]?.unitPriceCents;
      const openingAsk = ctx.history.find((e) => e.type === "open")?.unitPriceCents ?? ask;
      const proposed = last === undefined ? Math.round(openingAsk * opening) : Math.round((last + ask) / 2);
      const offer = Math.max(1, Math.min(proposed, max));
      return { type: "offer", unitPriceCents: offer, reasoning: `Countering with ${offer}; my limit is ${max}.` };
    },
  };
}