// Plays a simple scripted buyer against the seller. Offline, no keys.
// Usage: npm run seller:demo -- [sku] [quantity] [maxUnitPriceCents]
//   e.g. npm run seller:demo -- flour-25kg 2 4900
import { InMemoryLedger, MandateSchema, evaluatePolicy } from "@autopilot/guardrail";
import { Seller } from "../seller/seller.js";

const sku = process.argv[2] ?? "flour-25kg";
const qty = Number(process.argv[3] ?? 2);
const target = Number(process.argv[4] ?? 4_900); // buyer accepts any ask at or below this
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

const vendor = { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: "vendor@example.com" };
const seller = new Seller({ vendor });
const session = seller.openNegotiation(sku, qty);

console.log(`Buying ${qty} x ${sku}. Buyer will accept up to ${money(target)} per unit.\n`);
console.log(`Seller opens at ${money(session.currentAskCents)}/unit (total ${money(session.priceAt(session.currentAskCents).totalCents)})`);

let lastOffer = Math.round((session.currentAskCents * 2) / 3);
let nextOffer = lastOffer;
while (!session.closed && session.round < 6) {
  console.log(`  buyer offers ${money(nextOffer)}/unit`);
  const res = session.respond(nextOffer);
  if (res.action === "reject") {
    console.log(`  seller: ${res.message}`);
    break;
  }
  console.log(`  seller ${res.action}s ${money(res.unitPriceCents)}/unit (total ${money(res.totalCents)}): "${res.message}"`);
  if (res.action === "accept") break;
  lastOffer = nextOffer;
  nextOffer = res.unitPriceCents <= target ? res.unitPriceCents : Math.round((lastOffer + res.unitPriceCents) / 2);
}

if (session.agreedUnitPriceCents === undefined) {
  console.log("\nNo deal.");
  process.exit(0);
}

const deal = session.toDeal({ dealId: `deal-${Date.now().toString(36)}`, negotiationId: "neg-demo" });
const mandate = MandateSchema.parse({
  mandateId: "demo",
  currency: "USD",
  weeklyBudgetCents: 40_000,
  perTransactionCapCents: 30_000,
  autoApproveUnderCents: 10_000,
  categories: ["flour", "butter"],
  vendors: [vendor],
});
const verdict = evaluatePolicy({
  mandate,
  deal,
  request: { dealId: deal.dealId, payeeEmail: deal.payeeEmail, amountCents: deal.totalCents, currency: deal.currency },
  ledger: new InMemoryLedger(),
});
console.log(`\nDeal: ${money(deal.totalCents)} total. Policy gate says: ${verdict.decision.toUpperCase()}`);
for (const c of verdict.failed) console.log(`  x ${c.id}: ${c.message}`);