import type { Mandate } from "@autopilot/guardrail";
import type { MarketLookup, MarketSummary } from "../channel3/market.js";
import type { Llm } from "../llm/types.js";
import { parseMandate } from "../mandate/parser.js";
import type { BuyerStrategy } from "../negotiation/buyers.js";
import { runNegotiation, type NegotiationResult } from "../negotiation/loop.js";
import { submitPayment, type PaymentDeps } from "../payments/service.js";
import type { PaymentRecord } from "../payments/store.js";
import type { PublicProduct } from "../seller/catalog.js";
import type { Seller } from "../seller/seller.js";

export interface BuyerFactoryArgs {
  maxUnitPriceCents: number;
  market?: MarketLookup;
  businessContext?: string;
}

export interface PurchaseDeps {
  /** Used only to parse the owner's plain-English mandate. */
  llm: Llm;
  seller: Seller;
  payments: PaymentDeps;
  makeBuyer: (args: BuyerFactoryArgs) => BuyerStrategy;
  /** Optional Channel3 lookup: gives the shopping step (and the buyer) a retail price reference. */
  market?: MarketLookup;
  hardMaxWeeklyCents: number;
  now?: () => number;
}

export interface PurchaseRequest {
  /** The owner's instruction in plain English. */
  ownerText: string;
  /** What to restock now. */
    need: { category: string; quantity: number; maxUnitPriceCents?: number };
  /** An already-parsed mandate (e.g. confirmed by the owner earlier). Skips the LLM parse step. */
  parsedMandate?: { mandate: Mandate; assumptions: string[] };
}

export type PurchaseOutcome =
  | "mandate_error"
  | "category_not_authorized"
  | "no_product"
  | "no_deal"
  | "invoice_mismatch"
  | "payment_denied"
  | "awaiting_approval"
  | "payment_started"
  | "payment_failed";

export interface PurchaseResult {
  outcome: PurchaseOutcome;
  error?: string;
  mandate?: Mandate;
  assumptions?: string[];
  product?: PublicProduct;
  market?: MarketSummary;
  unitLimitCents?: number;
  negotiation?: NegotiationResult;
  payment?: PaymentRecord;
}

/**
 * Default per-unit ceiling for the buyer.
 * - If staying strictly under the owner's auto-approve line (worst-case shipping included) still leaves a
 *   realistic price (at least 70% of list), use that, so the order can be paid without bothering the owner.
 * - Otherwise the order is meant to go to the owner for approval ("ask me for the rest"): allow up to 85% of
 *   list, but never more than the per-purchase cap spread over the quantity.
 */
export function defaultUnitLimitCents(
  mandate: Pick<Mandate, "autoApproveUnderCents" | "perTransactionCapCents">,
  product: Pick<PublicProduct, "shippingCents" | "listUnitPriceCents">,
  quantity: number,
): number {
  const autoUnit = Math.floor((mandate.autoApproveUnderCents - 1 - product.shippingCents) / quantity);
  if (autoUnit >= Math.round(product.listUnitPriceCents * 0.7)) return autoUnit;
  const capUnit = Math.max(1, Math.floor((mandate.perTransactionCapCents - product.shippingCents) / quantity));
  return Math.min(capUnit, Math.round(product.listUnitPriceCents * 0.85));
}

/**
 * The whole purchase: mandate -> shop -> negotiate -> policy gate -> payment.
 * Money can only move inside submitPayment, and only after the deterministic policy gate allows it.
 */
export async function runPurchase(d: PurchaseDeps, req: PurchaseRequest): Promise<PurchaseResult> {
  const { vendor } = d.seller;
  const category = req.need.category.trim().toLowerCase();
  const catalog = d.seller.listProducts();

  // 1. Mandate
  let mandate: Mandate;
  let assumptions: string[];
    try {
    ({ mandate, assumptions } = await parseMandate(req.ownerText, {
      llm: d.llm,
      vendors: [vendor],
      hardMaxWeeklyCents: d.hardMaxWeeklyCents,
      knownCategories: [...new Set(catalog.map((p) => p.category))],
    }));
  } catch (e) {
    return { outcome: "mandate_error", error: (e as Error).message };
  }

  // 2. Shop
  if (!mandate.categories.includes(category)) {
    return { outcome: "category_not_authorized", mandate, assumptions, error: `"${category}" is not in the owner's mandate.` };
  }
  const product = catalog.filter((p) => p.category === category).sort((a, b) => a.listUnitPriceCents - b.listUnitPriceCents)[0];
  if (!product) return { outcome: "no_product", mandate, assumptions, error: `${vendor.name} does not sell "${category}".` };

  let market: MarketSummary | undefined;
  if (d.market) {
    try {
      market = await d.market(product.name);
    } catch {
      market = undefined; // a failed price check never blocks a purchase
    }
  }

  // 3. Negotiate
  const unitLimitCents = req.need.maxUnitPriceCents ?? defaultUnitLimitCents(mandate, product, req.need.quantity);
  const hint =
    market && market.count > 0
      ? `Retail reference from other merchants (rough): ${market.count} listings, median ${market.medianCents} cents, cheapest ${market.minCents} cents.`
      : undefined;
  const negotiation = await runNegotiation({
    seller: d.seller,
    buyer: d.makeBuyer({
      maxUnitPriceCents: unitLimitCents,
      market: d.market,
      businessContext: ["Small business restocking supplies; wants a good price and reliable supply.", hint].filter(Boolean).join(" "),
    }),
    sku: product.sku,
    quantity: req.need.quantity,
    now: d.now,
  });
  const base = { mandate, assumptions, product, market, unitLimitCents, negotiation };
    if (negotiation.outcome === "invoice_mismatch") {
    return { outcome: "invoice_mismatch", error: "The vendor's invoice did not match the agreed terms.", ...base };
  }
  if (negotiation.outcome !== "deal" || !negotiation.deal) return { outcome: "no_deal", ...base };

  // 4. Policy gate + payment
  const payment = await submitPayment(d.payments, mandate, negotiation.deal);
  const outcome: PurchaseOutcome =
    payment.status === "PROCESSING" || payment.status === "SUCCESS"
      ? "payment_started"
      : payment.status === "PENDING_APPROVAL"
        ? "awaiting_approval"
        : payment.status === "DENIED"
          ? "payment_denied"
          : "payment_failed";
  return { outcome, ...base, payment };
}