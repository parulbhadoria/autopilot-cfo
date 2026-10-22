import type { Channel3Client, MarketOffer } from "./client.js";

/**
 * What the buyer agent is allowed to learn from the open web: numbers only.
 * Titles and URLs come from third parties and could carry prompt injection, so they never reach the model.
 */
export interface MarketSummary {
  query: string;
  currency: string;
  /** Listings the search returned, before filtering. */
  considered: number;
  /** Listings that are relevant, new, in stock and in the right currency. 0 means no comparable listings. */
  count: number;
  minCents?: number;
  medianCents?: number;
  maxCents?: number;
  cheapest: { domain: string; priceCents: number }[];
}

const safeDomain = (d: string) => (/^[a-z0-9]([a-z0-9.-]{0,58}[a-z0-9])?$/i.test(d) ? d.toLowerCase() : "unknown");

const STOP_WORDS = new Set(["the", "and", "for", "with", "pack", "set", "size", "per", "bulk", "new", "pcs", "piece", "pieces", "lbs"]);

/** Meaningful words of a query: letters only, 3+ chars, no filler. Units like "25kg" drop out on purpose. */
export function queryTokens(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP_WORDS.has(w)))];
}

/**
 * Catalog search is semantic, so "bread flour" can return bread makers. Keep an offer only when its title
 * contains at least 60% of the query's meaningful words. Judged in code; the model never sees titles.
 */
export function isRelevant(query: string, title: string): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;
  const t = title.toLowerCase();
  const hits = tokens.filter((k) => t.includes(k)).length;
  return hits >= Math.ceil(tokens.length * 0.6);
}

export function summarizeMarket(query: string, offers: MarketOffer[], currency = "USD"): MarketSummary {
  const usable = offers
    .filter(
      (o) =>
        o.inStock &&
        o.currency === currency.toUpperCase() &&
        (o.condition === "" || o.condition === "new") &&
        isRelevant(query, o.title),
    )
    .sort((a, b) => a.priceCents - b.priceCents);
  const base = { query: query.slice(0, 100), currency: currency.toUpperCase(), considered: offers.length, count: usable.length };
  if (usable.length === 0) return { ...base, cheapest: [] };
  return {
    ...base,
    minCents: usable[0].priceCents,
    medianCents: usable[Math.floor((usable.length - 1) / 2)].priceCents,
    maxCents: usable[usable.length - 1].priceCents,
    cheapest: usable.slice(0, 3).map((o) => ({ domain: safeDomain(o.domain), priceCents: o.priceCents })),
  };
}

export type MarketLookup = (query: string) => Promise<MarketSummary>;

/** A lookup the LLM buyer can call. Identical queries are cached so each negotiation spends at most one API credit per query. */
export function createMarketLookup(client: Channel3Client, o: { currency?: string; limit?: number } = {}): MarketLookup {
  const cache = new Map<string, Promise<MarketSummary>>();
  return (query) => {
    const q = query.trim().replace(/\s+/g, " ").slice(0, 100);
    if (q.length < 2) return Promise.reject(new Error("Query is too short."));
    const key = q.toLowerCase();
    let hit = cache.get(key);
    if (!hit) {
      hit = client.search({ query: q, limit: o.limit ?? 10 }).then((offers) => summarizeMarket(q, offers, o.currency ?? "USD"));
      cache.set(key, hit);
      hit.catch(() => cache.delete(key));
    }
    return hit;
  };
}