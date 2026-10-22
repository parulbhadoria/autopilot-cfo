import { DEFAULT_CATALOG, bulkDiscountPct, toPublic, validateCatalog, type Product, type PublicProduct } from "./catalog.js";

export interface SellerVendor {
  vendorId: string;
  name: string;
  payeeEmail: string;
}

export interface SellerOptions {
  vendor: SellerVendor;
  catalog?: Product[];
  currency?: string;
  /** Buyer messages allowed before the seller walks away. */
  maxRounds?: number;
  /** Share of the remaining gap the seller gives up on each counter (0-1). */
  concessionRate?: number;
  /** Offers below this % of the floor get no concession at all. */
  lowballPct?: number;
  quoteTtlMs?: number;
  now?: () => number;
}

export interface OrderPrice {
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
}

export type SellerResponse =
  | ({ action: "accept"; unitPriceCents: number; round: number; message: string } & OrderPrice)
  | ({ action: "counter"; unitPriceCents: number; round: number; message: string } & OrderPrice)
  | { action: "reject"; round: number; message: string };

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function priceOrder(p: Pick<Product, "shippingCents" | "freeShippingOverCents">, qty: number, unitPriceCents: number): OrderPrice {
  const subtotalCents = unitPriceCents * qty;
  const free = p.freeShippingOverCents !== undefined && subtotalCents >= p.freeShippingOverCents;
  const shippingCents = free ? 0 : p.shippingCents;
  return { subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

export class Seller {
  readonly vendor: SellerVendor;
  readonly currency: string;
  #catalog: Product[];
  #opts: Required<Pick<SellerOptions, "maxRounds" | "concessionRate" | "lowballPct" | "quoteTtlMs">>;
  #now: () => number;

  constructor(opts: SellerOptions) {
    this.vendor = opts.vendor;
    this.currency = (opts.currency ?? "USD").toUpperCase();
    this.#catalog = opts.catalog ?? DEFAULT_CATALOG;
    validateCatalog(this.#catalog);
    this.#opts = {
      maxRounds: opts.maxRounds ?? 4,
      concessionRate: opts.concessionRate ?? 0.5,
      lowballPct: opts.lowballPct ?? 60,
      quoteTtlMs: opts.quoteTtlMs ?? 10 * 60_000,
    };
    this.#now = opts.now ?? Date.now;
  }

  /** Public catalog: list prices and bulk tiers, never the floor. */
  listProducts(): PublicProduct[] {
    return this.#catalog.map(toPublic);
  }

  openNegotiation(sku: string, quantity: number): SellerSession {
    const product = this.#catalog.find((p) => p.sku === sku);
    if (!product) throw new Error(`Unknown sku "${sku}"`);
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quantity must be a positive integer");
    if (quantity > product.stock) throw new Error(`Only ${product.stock} of ${sku} in stock`);
    return this.wrapSession(new SellerSession(this.vendor, this.currency, product, quantity, this.#opts, this.#now));
  }

  /** Extension point used by the test-only malicious seller. The honest seller returns the session unchanged. */
  protected wrapSession(session: SellerSession): SellerSession {
    return session;
  }
}

export class SellerSession {
  readonly sku: string;
  readonly quantity: number;
  #vendor: SellerVendor;
  #currency: string;
  #product: Product;
  #floor: number;
  #ask: number;
  #round = 0;
  #closed = false;
  #agreed?: number;
  #o: { maxRounds: number; concessionRate: number; lowballPct: number; quoteTtlMs: number };
  #now: () => number;

  constructor(
    vendor: SellerVendor,
    currency: string,
    product: Product,
    quantity: number,
    o: { maxRounds: number; concessionRate: number; lowballPct: number; quoteTtlMs: number },
    now: () => number,
  ) {
    this.sku = product.sku;
    this.quantity = quantity;
    this.#vendor = vendor;
    this.#currency = currency;
    this.#product = product;
    this.#floor = product.floorUnitPriceCents;
    this.#o = o;
    this.#now = now;
    const discounted = Math.round((product.listUnitPriceCents * (100 - bulkDiscountPct(product, quantity))) / 100);
    this.#ask = Math.max(this.#floor, discounted);
  }

  get round() {
    return this.#round;
  }
  get closed() {
    return this.#closed;
  }
  get currentAskCents() {
    return this.#ask;
  }
  get agreedUnitPriceCents() {
    return this.#agreed;
  }

  priceAt(unitPriceCents: number): OrderPrice {
    return priceOrder(this.#product, this.quantity, unitPriceCents);
  }

  #accept(unitPriceCents: number, round: number): SellerResponse {
    this.#closed = true;
    this.#agreed = unitPriceCents;
    return {
      action: "accept",
      unitPriceCents,
      round,
      message: `Deal at ${money(unitPriceCents)} per unit.`,
      ...this.priceAt(unitPriceCents),
    };
  }

  #counter(round: number, message: string): SellerResponse {
    return { action: "counter", unitPriceCents: this.#ask, round, message, ...this.priceAt(this.#ask) };
  }

  /** The buyer proposes a unit price. The seller accepts, counters, or walks away. */
  respond(offerUnitPriceCents: number): SellerResponse {
    if (this.#closed) return { action: "reject", round: this.#round, message: "This negotiation is closed." };
    if (!Number.isSafeInteger(offerUnitPriceCents) || offerUnitPriceCents <= 0) {
      return { action: "reject", round: this.#round, message: "Invalid offer." };
    }

    const round = ++this.#round;
    const offer = offerUnitPriceCents;
    const ask = this.#ask;

    if (offer >= ask) return this.#accept(ask, round);

    if (round >= this.#o.maxRounds) {
      if (offer >= this.#floor) return this.#accept(offer, round);
      this.#closed = true;
      return { action: "reject", round, message: "Sorry, we can't get to that price. We're walking away." };
    }

    if (offer * 100 < this.#floor * this.#o.lowballPct) {
      return this.#counter(round, `That offer is too low for us to move on. Our price stays at ${money(ask)} per unit.`);
    }

    const bound = Math.max(offer, this.#floor);
    const gap = ask - bound;
    const concession = Math.min(gap, Math.ceil(gap * this.#o.concessionRate));
    this.#ask = ask - concession;
    return this.#counter(round, `Best I can do is ${money(this.#ask)} per unit.`);
  }

  /** Terms of the agreed deal, shaped for the guardrail's DealSchema. Only available after an accept. */
  toDeal(args: { dealId: string; negotiationId: string }) {
    if (this.#agreed === undefined) throw new Error("No agreed price yet.");
    const t = this.priceAt(this.#agreed);
    return {
      dealId: args.dealId,
      negotiationId: args.negotiationId,
      vendorId: this.#vendor.vendorId,
      payeeEmail: this.#vendor.payeeEmail,
      category: this.#product.category,
      quantity: this.quantity,
      unitPriceCents: this.#agreed,
      shippingCents: t.shippingCents,
      otherFeesCents: 0,
      totalCents: t.totalCents,
      currency: this.#currency,
      expiresAt: this.#now() + this.#o.quoteTtlMs,
    };
  }
}