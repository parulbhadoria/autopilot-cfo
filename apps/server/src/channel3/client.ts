import { postJsonWithRetry } from "../llm/http.js";

/** One merchant listing, normalised. Prices are integer cents. */
export interface MarketOffer {
  productId: string;
  title: string;
  domain: string;
  priceCents: number;
  currency: string;
  inStock: boolean;
  condition: string;
  url: string;
}

export interface SearchOptions {
  query: string;
  /** Number of products to request. Default 10. */
  limit?: number;
  /** Only in-stock / limited-availability offers. Default true. */
  inStockOnly?: boolean;
}

export interface Channel3Client {
  /** The unmodified API response, for debugging the response shape. */
  searchRaw(o: SearchOptions): Promise<unknown>;
  search(o: SearchOptions): Promise<MarketOffer[]>;
}

export interface Channel3Options {
  apiKey: () => string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const IN_STOCK = new Set(["InStock", "LimitedAvailability"]);

/**
 * Turns a /v1/search response into flat offers. Tolerant on purpose: the docs show the price either as
 * { amount, currency } or as a nested { price, currency }, so both are accepted. Prices arrive in major
 * units (110 = $110.00) and are converted to cents. Anything malformed is skipped, never guessed.
 */
export function normalizeProducts(raw: unknown): MarketOffer[] {
  const products = (raw as any)?.products;
  if (!Array.isArray(products)) return [];
  const out: MarketOffer[] = [];

  for (const p of products) {
    const offers = Array.isArray(p?.offers) ? p.offers : [];
    for (const o of offers) {
      const node = o?.price;
      let amount: unknown;
      let currency: unknown;
      if (typeof node === "number") {
        amount = node;
        currency = o?.currency;
      } else if (node && typeof node === "object") {
        amount = node.price ?? node.amount;
        currency = node.currency ?? o?.currency;
      }
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) continue;
      if (typeof currency !== "string" || currency.length !== 3) continue;

      out.push({
        productId: String(p?.id ?? ""),
        title: typeof p?.title === "string" ? p.title : "",
        domain: typeof o?.domain === "string" ? o.domain : "unknown",
        priceCents: Math.round(amount * 100),
        currency: currency.toUpperCase(),
        inStock: IN_STOCK.has(String(o?.availability)),
        condition: typeof o?.condition === "string" ? o.condition.toLowerCase() : "",
        url: typeof o?.url === "string" ? o.url : "",
      });
    }
  }
  return out;
}

export function createChannel3Client(o: Channel3Options): Channel3Client {
  const baseUrl = o.baseUrl ?? "https://api.trychannel3.com";
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const searchRaw = (s: SearchOptions) =>
    postJsonWithRetry({
      name: "Channel3",
      url: `${baseUrl}/v1/search`,
      headers: { "x-api-key": o.apiKey(), "content-type": "application/json" },
      body: {
        query: s.query,
        limit: s.limit ?? 10,
        ...(s.inStockOnly === false ? {} : { filters: { availability: ["InStock", "LimitedAvailability"] } }),
      },
      fetchImpl: o.fetchImpl ?? fetch,
      sleep,
      maxRetries: o.maxRetries ?? 3,
    });

  return {
    searchRaw,
    async search(s) {
      return normalizeProducts(await searchRaw(s));
    },
  };
}

/** Returns a client when CHANNEL3_API_KEY is set, otherwise undefined. */
export function createChannel3FromEnv(env: NodeJS.ProcessEnv = process.env): Channel3Client | undefined {
  if (!env.CHANNEL3_API_KEY) return undefined;
  return createChannel3Client({ apiKey: () => env.CHANNEL3_API_KEY as string });
}