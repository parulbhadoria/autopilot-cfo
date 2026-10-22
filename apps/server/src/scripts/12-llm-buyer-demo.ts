// Runs the negotiation with an LLM buyer (Groq, via tool calling) against the seller, then the policy gate.
// Needs GROQ_API_KEY in .env. If CHANNEL3_API_KEY is also set, the buyer can look up market prices.
// The model may behave a little differently on every run.
// Usage: npm run buyer:demo -- [sku] [quantity] [maxUnitPriceCents]
//   e.g. npm run buyer:demo -- flour-25kg 2 4900
import "../config.js"; // loads .env
import { InMemoryLedger, MandateSchema, evaluatePolicy } from "@autopilot/guardrail";
import { createChannel3FromEnv, createMarketLookup } from "../channel3/index.js";
import { createToolChatFromEnv } from "../llm/index.js";
import { createLlmBuyer, runNegotiation } from "../negotiation/index.js";
import { Seller } from "../seller/seller.js";

const args = process.argv.slice(2);
const sku = args[0] ?? "flour-25kg";
const qty = Number(args[1] ?? 2);
const maxUnit = Number(args[2] ?? 4_900);
const money = (c?: number) => (c === undefined ? "      " : `$${(c / 100).toFixed(2)}`.padStart(8));

const chat = createToolChatFromEnv();
if (!chat) {
  console.error("GROQ_API_KEY is not set in .env (get a free key at console.groq.com).");
  process.exit(1);
}

const channel3 = createChannel3FromEnv();
const lookup = channel3 ? createMarketLookup(channel3) : undefined;
console.log(lookup ? "Market price tool: ON (Channel3)" : "Market price tool: off (no CHANNEL3_API_KEY)");

const vendor = { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: "vendor@example.com" };
const result = await runNegotiation({
  seller: new Seller({ vendor }),
  buyer: createLlmBuyer({
    chat,
    maxUnitPriceCents: maxUnit,
    businessContext: "Neighbourhood bakery restocking flour; wants the best price but needs reliable supply.",
    market: lookup
      ? async (q) => {
          const s = await lookup(q);
          console.log(`  [market_prices] "${s.query}" -> ${s.considered} listings found, ${s.count} relevant` + (s.count ? `, median ${money(s.medianCents).trim()}, min ${money(s.minCents).trim()}` : " (no comparable data)"));
          return s;
        }
      : undefined,
  }),
  sku,
  quantity: qty,
});

console.log(`LLM buyer negotiating ${qty} x ${sku}; hard limit ${money(maxUnit).trim()} per unit.\n`);
console.log("seq round from   type      unit      total");
for (const e of result.transcript) {
  console.log(
    `${String(e.seq).padStart(3)} ${String(e.round).padStart(5)} ${e.from.padEnd(6)} ${e.type.padEnd(9)} ${money(e.unitPriceCents)} ${money(e.totalCents)}  ${e.reasoning || e.message || ""}`,
  );
}
console.log(`\nOutcome: ${result.outcome} after ${result.rounds} round(s)`);

if (result.deal) {
  const d = result.deal;
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
    deal: d,
    request: { dealId: d.dealId, payeeEmail: d.payeeEmail, amountCents: d.totalCents, currency: d.currency },
    ledger: new InMemoryLedger(),
  });
  console.log(`Deal ${money(d.totalCents).trim()} at ${money(d.unitPriceCents).trim()}/unit. Policy gate says: ${verdict.decision.toUpperCase()}`);
  for (const c of verdict.failed) console.log(`  x ${c.id}: ${c.message}`);
}