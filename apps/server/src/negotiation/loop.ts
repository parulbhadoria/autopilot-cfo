import { randomUUID } from "node:crypto";
import type { Seller } from "../seller/seller.js";
import { BuyerDecisionSchema, TranscriptEntrySchema, type TranscriptEntry } from "./messages.js";
import type { BuyerContext, BuyerStrategy } from "./buyers.js";

export type Outcome =
  | "deal"
  | "buyer_walked_away"
  | "seller_walked_away"
  | "no_agreement"
  | "quote_expired"
  | "invoice_mismatch"
  | "invalid_buyer_decision";

export interface NegotiationOptions {
  seller: Seller;
  buyer: BuyerStrategy;
  sku: string;
  quantity: number;
  negotiationId?: string;
  dealId?: string;
  /** Maximum buyer messages. Default 4. */
  maxRounds?: number;
  /** How long each seller quote stays valid. Default 10 minutes. */
  quoteTtlMs?: number;
  now?: () => number;
}

export interface NegotiationResult {
  negotiationId: string;
  outcome: Outcome;
  rounds: number;
  transcript: TranscriptEntry[];
  /** Present only when outcome is "deal". Shaped for the guardrail's DealSchema. */
  deal?: ReturnType<ReturnType<Seller["openNegotiation"]>["toDeal"]>;
}

/**
 * Runs buyer vs seller to a conclusion. Every message is recorded. The buyer's output is
 * validated and anything malformed ends the negotiation (fail closed). Nothing here moves
 * money: a "deal" is only a proposal that must still pass the policy gate.
 */
export async function runNegotiation(o: NegotiationOptions): Promise<NegotiationResult> {
  const now = o.now ?? Date.now;
  const negotiationId = o.negotiationId ?? `neg_${randomUUID()}`;
  const maxRounds = o.maxRounds ?? 4;
  const ttl = o.quoteTtlMs ?? 10 * 60_000;

  const session = o.seller.openNegotiation(o.sku, o.quantity);
  const product = o.seller.listProducts().find((p) => p.sku === o.sku)!;

  const transcript: TranscriptEntry[] = [];
  let round = 0;
  let seq = 0;
  let expiresAt = now() + ttl;

  const terms = (unit: number) => {
    const t = session.priceAt(unit);
    return { unitPriceCents: unit, shippingCents: t.shippingCents, totalCents: t.totalCents };
  };
  const push = (e: Pick<TranscriptEntry, "from" | "type"> & Partial<TranscriptEntry>) => {
    transcript.push(
      TranscriptEntrySchema.parse({
        negotiationId,
        seq: seq++,
        at: now(),
        round,
        sku: o.sku,
        quantity: o.quantity,
        currency: o.seller.currency,
        ...e,
      }),
    );
  };
  const end = (outcome: Outcome, deal?: NegotiationResult["deal"]): NegotiationResult => ({
    negotiationId,
    outcome,
    rounds: round,
    transcript,
    deal,
  });
    /**
   * The vendor's invoice must match what was agreed in the transcript. A vendor that raises the price or
   * adds fees after saying yes is caught here, before anything reaches the payment step.
   */
  const agreed = () => {
    const invoice = session.toDeal({ dealId: o.dealId ?? `deal_${randomUUID()}`, negotiationId });
    const accepted = [...transcript].reverse().find((e) => e.from === "seller" && e.type === "accept");
    if (
      !accepted ||
      invoice.unitPriceCents !== accepted.unitPriceCents ||
      invoice.totalCents !== accepted.totalCents ||
      invoice.quantity !== o.quantity
    ) {
      push({
        from: "buyer",
        type: "reject",
        unitPriceCents: invoice.unitPriceCents,
        totalCents: invoice.totalCents,
        reasoning: `Invoice (${invoice.unitPriceCents}/unit, total ${invoice.totalCents}) does not match the agreed terms (${accepted?.unitPriceCents}/unit, total ${accepted?.totalCents}). Refusing to pay.`,
      });
      return end("invoice_mismatch");
    }
    return end("deal", invoice);
  };

  push({ from: "seller", type: "open", ...terms(session.currentAskCents), expiresAt, message: "Opening price." });

  while (round < maxRounds) {
    round++;

    const ctx: BuyerContext = {
      negotiationId,
      sku: o.sku,
      quantity: o.quantity,
      currency: o.seller.currency,
      round,
      maxRounds,
      product,
      sellerAsk: { ...terms(session.currentAskCents), expiresAt },
      history: transcript.map((e) => ({ ...e })),
    };

    let decision;
    try {
      const parsed = BuyerDecisionSchema.safeParse(await o.buyer.decide(ctx));
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
      decision = parsed.data;
    } catch (e) {
      push({ from: "buyer", type: "walk_away", reasoning: `Invalid buyer decision: ${(e as Error).message}` });
      return end("invalid_buyer_decision");
    }

    if (decision.type === "walk_away") {
      push({ from: "buyer", type: "walk_away", reasoning: decision.reasoning });
      return end("buyer_walked_away");
    }

    // The buyer took too long: the seller's quote lapsed while it was deciding.
    if (now() > expiresAt) {
      push({ from: "seller", type: "expired", message: "Quote expired before the buyer responded." });
      return end("quote_expired");
    }

    if (decision.type === "accept") {
      push({ from: "buyer", type: "accept", ...terms(session.currentAskCents), reasoning: decision.reasoning });
      const res = session.respond(session.currentAskCents); // accepting means paying the current ask
      if (res.action !== "accept") {
        push({ from: "seller", type: "walk_away", message: res.message });
        return end("seller_walked_away");
      }
      push({ from: "seller", type: "accept", ...terms(res.unitPriceCents), message: res.message });
      return agreed();
    }

    push({ from: "buyer", type: "offer", ...terms(decision.unitPriceCents), reasoning: decision.reasoning });
    const res = session.respond(decision.unitPriceCents);

    if (res.action === "accept") {
      push({ from: "seller", type: "accept", ...terms(res.unitPriceCents), message: res.message });
      return agreed();
    }
    if (res.action === "counter") {
      expiresAt = now() + ttl;
      push({ from: "seller", type: "counter", ...terms(res.unitPriceCents), expiresAt, message: res.message });
      continue;
    }
    push({ from: "seller", type: "walk_away", message: res.message });
    return end("seller_walked_away");
  }

  push({ from: "buyer", type: "walk_away", reasoning: `No agreement within ${maxRounds} rounds.` });
  return end("no_agreement");
}