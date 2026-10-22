// Searches Channel3 and shows the normalised offers plus the market summary the buyer agent would see.
// Needs CHANNEL3_API_KEY in .env. Each search costs one API credit.
// Usage: npm run channel3:search -- "bread flour 25kg" [--raw]
//   --raw prints the first product exactly as the API returned it (use this to check the response shape).
import "../config.js"; // loads .env
import { createChannel3FromEnv, isRelevant, summarizeMarket } from "../channel3/index.js";

const raw = process.argv.includes("--raw");
const query = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ") || "bread flour 25kg";
const usd = (c?: number) => (c === undefined ? "n/a" : `$${(c / 100).toFixed(2)}`);

const client = createChannel3FromEnv();
if (!client) {
  console.error("CHANNEL3_API_KEY is not set in .env (free key at trychannel3.com).");
  process.exit(1);
}

try {
  const response: any = await client.searchRaw({ query, limit: 10 });
  if (raw) {
    console.log(JSON.stringify(response?.products?.[0] ?? response, null, 2));
    process.exit(0);
  }
  const { normalizeProducts } = await import("../channel3/client.js");
  const offers = normalizeProducts(response);

  console.log(`Query: "${query}"  ->  ${response?.products?.length ?? 0} products, ${offers.length} usable offers\n`);
  console.log("price      stock  match  merchant                 title");
  for (const o of offers.slice(0, 15)) {
    console.log(`${usd(o.priceCents).padEnd(10)} ${(o.inStock ? "yes" : "no").padEnd(6)} ${(isRelevant(query, o.title) ? "yes" : "no").padEnd(6)} ${o.domain.slice(0, 24).padEnd(24)} ${o.title.slice(0, 50)}`);
  }
  const s = summarizeMarket(query, offers);
  console.log(`\nWhat the buyer agent sees (numbers only): ${s.considered} listings found, ${s.count} relevant` + (s.count ? `; min=${usd(s.minCents)} median=${usd(s.medianCents)} max=${usd(s.maxCents)}` : "; no comparable data"));
  console.log("cheapest:", s.cheapest.map((c) => `${c.domain} ${usd(c.priceCents)}`).join(", ") || "none");
  if (offers.length === 0) console.log("\nNo usable offers. Re-run with --raw to inspect the response and send it to me.");
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}