// Runs the full negotiation loop (rule-based buyer vs seller) and sends the result through the policy gate.
// Offline, no keys.
// Usage: npm run negotiate:demo -- [sku] [quantity] [maxUnitPriceCents] [--json]
//   e.g. npm run negotiate:demo -- flour-25kg 2 4900
//        npm run negotiate:demo -- flour-25kg 2 4000    (seller walks away)
//        npm run negotiate:demo -- flour-25kg 2 3500    (buyer walks away)
import { InMemoryLedger, MandateSchema, evaluatePolicy } from "@autopilot/guardrail";
import { createRuleBuyer, runNegotiation } from "../negotiation/index.js";
import { Seller } from "../seller/seller.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const asJson = process.argv.includes("--json");
const sku = args[0] ?? "flour-25kg";
const qty = Number(args[1] ?? 2);
const maxUnit = Number(args[2] ?? 4_900);
const money = (c?: number) => (c === undefined ? "      " : `$${(c / 100).toFixed(2)}`.padStart(8));

const vendor = { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: "vendor@example.com" };
const result = await runNegotiation({
  seller: new Seller({ vendor }),
  buyer: createRuleBuyer({ maxUnitPriceCents: maxUnit }),
  sku,
  quantity: qty,
});

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`Negotiating ${qty} x ${sku}; buyer limit ${money(maxUnit).trim()} per unit.\n`);
console.log("seq round from   type      unit      total");
for (const e of result.transcript) {
  const note = e.reasoning || e.message || "";
  console.log(
    `${String(e.seq).padStart(3)} ${String(e.round).padStart(5)} ${e.from.padEnd(6)} ${e.type.padEnd(9)} ${money(e.unitPriceCents)} ${money(e.totalCents)}  ${note}`,
  );
}
console.log(`\nOutcome: ${result.outcome} after ${result.rounds} round(s)`);

if (result.deal) {
  const deal = result.deal;
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
  console.log(`Deal ${money(deal.totalCents).trim()}. Policy gate says: ${verdict.decision.toUpperCase()}`);
  for (const c of verdict.failed) console.log(`  x ${c.id}: ${c.message}`);
}