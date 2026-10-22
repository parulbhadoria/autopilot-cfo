// The full pipeline: plain-English mandate -> shop (+ market price check) -> negotiate -> policy gate -> PayPal payout.
//
// Usage: npm run pipeline:demo -- [category] [quantity] ["owner instruction"] [flags]
//   flags:  --dry       fake PayPal (no money moves, no PayPal keys needed)
//           --offline   no LLM calls: fixed mandate + rule-based buyer (no Groq / Channel3 keys needed)
//           --approve   if the deal needs owner approval, approve it automatically (simulates the owner)
//   e.g.    npm run pipeline:demo -- "sheet pans" 4
//           npm run pipeline:demo -- "sheet pans" 4 --dry --offline
import "../config.js"; // loads .env
import { InMemoryLedger } from "@autopilot/guardrail";
import { createChannel3FromEnv, createMarketLookup } from "../channel3/index.js";
import { config } from "../config.js";
import type { Llm } from "../llm/types.js";
import { createLlmFromEnv, createToolChatFromEnv } from "../llm/index.js";
import { createLlmBuyer, createRuleBuyer } from "../negotiation/index.js";
import { approvePayment, type PaymentDeps } from "../payments/service.js";
import { PaymentStore } from "../payments/store.js";
import { createPayoutsClient, getPayoutBatch, type PayoutsClient } from "../paypal/payouts.js";
import { printError } from "../paypal/client.js";
import { runPurchase } from "../pipeline/index.js";
import { Seller } from "../seller/seller.js";

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dry = flags.has("--dry");
const offline = flags.has("--offline");
const category = args[0] ?? "sheet pans";
const quantity = Number(args[1] ?? 4);
const ownerText = args[2] ?? "Keep flour, butter and sheet pans stocked, max $400/week, auto-approve under $100, ask me for the rest.";
const usd = (c?: number) => (c === undefined ? "n/a" : `$${(c / 100).toFixed(2)}`);

const vendorEmail = dry || offline ? "vendor@example.com" : config.vendorEmail();
if (!vendorEmail) {
  console.error("Set VENDOR_EMAIL in .env (your sandbox personal account email), or run with --dry.");
  process.exit(1);
}

// --- dependencies -----------------------------------------------------------
const fakePayouts: PayoutsClient = {
  async createPayout(a) {
    console.log(`   [dry] would send ${usd(a.amountCents)} ${a.currency} to ${a.email}`);
    return { payoutBatchId: `DRY-${a.senderBatchId}`, batchStatus: "PENDING" };
  },
};
const payments: PaymentDeps = { ledger: new InMemoryLedger(), store: new PaymentStore(), payouts: dry ? fakePayouts : createPayoutsClient() };

let llm: Llm | undefined;
if (offline) {
  llm = { complete: async () => JSON.stringify({ weeklyBudget: 400, autoApproveUnder: 100, categories: ["flour", "butter", "sheet pans"], assumptions: [] }) };
} else {
  llm = createLlmFromEnv();
}
const chat = offline ? undefined : createToolChatFromEnv();
if (!llm || (!offline && !chat)) {
  console.error("GROQ_API_KEY is not set in .env (free key at console.groq.com). Or run with --offline.");
  process.exit(1);
}
const channel3 = offline ? undefined : createChannel3FromEnv();
const market = channel3 ? createMarketLookup(channel3) : undefined;

const seller = new Seller({ vendor: { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: vendorEmail } });

// --- run --------------------------------------------------------------------
console.log(`Owner: "${ownerText}"`);
console.log(`Need:  ${quantity} x ${category}   [${offline ? "offline" : "live LLM"}${market ? " + Channel3" : ""}${dry ? ", dry PayPal" : ", PayPal sandbox"}]\n`);

try {
  const r = await runPurchase(
    {
      llm,
      seller,
      payments,
      market,
      hardMaxWeeklyCents: config.hardMaxWeeklyCents(),
      makeBuyer: (a) => (offline ? createRuleBuyer({ maxUnitPriceCents: a.maxUnitPriceCents }) : createLlmBuyer({ chat: chat!, ...a })),
    },
    { ownerText, need: { category, quantity } },
  );

  if (r.mandate) {
    const m = r.mandate;
    console.log(`1) MANDATE  weekly ${usd(m.weeklyBudgetCents)} | per-purchase cap ${usd(m.perTransactionCapCents)} | auto-approve under ${usd(m.autoApproveUnderCents)} | categories: ${m.categories.join(", ")}`);
    for (const a of r.assumptions ?? []) console.log(`   assumption: ${a}`);
  }
  if (r.product) {
    console.log(`2) SHOP     ${r.product.name} at ${usd(r.product.listUnitPriceCents)} list (${seller.vendor.name})`);
    if (r.market) {
      console.log(r.market.count > 0
        ? `   market check: ${r.market.count} relevant retail listings, median ${usd(r.market.medianCents)}, cheapest ${usd(r.market.minCents)}`
        : `   market check: ${r.market.considered} listings found, none comparable`);
    }
    console.log(`   buyer's unit limit: ${usd(r.unitLimitCents)}`);
  }
  if (r.negotiation) {
    console.log("3) NEGOTIATE");
    for (const e of r.negotiation.transcript) {
      console.log(`   ${String(e.seq).padStart(2)} r${e.round} ${e.from.padEnd(6)} ${e.type.padEnd(9)} ${usd(e.unitPriceCents).padStart(8)} ${usd(e.totalCents).padStart(9)}  ${(e.reasoning || e.message || "").slice(0, 110)}`);
    }
    console.log(`   outcome: ${r.negotiation.outcome}`);
  }

  let payment = r.payment;
  let finalOutcome: string = r.outcome;
  if (payment) {
    console.log(`4) POLICY GATE + PAYMENT  decision=${payment.decision}  status=${payment.status}  amount=${usd(payment.amountCents)}`);
    console.log(`   ${payment.summary}`);
    for (const c of payment.checks.filter((c) => !c.passed)) console.log(`   x ${c.id}: ${c.message}`);

    if (payment.status === "PENDING_APPROVAL" && flags.has("--approve")) {
      console.log("   owner approves...");
      payment = await approvePayment(payments, r.mandate!, payment.paymentId);
      console.log(`   -> status=${payment.status}  ${payment.summary}`);
      finalOutcome = ["PROCESSING", "SUCCESS"].includes(payment.status) ? "payment_started (after owner approval)" : `payment ${payment.status.toLowerCase()}`;
    }
    if (payment.payoutBatchId && !dry) {
      for (let i = 0; i < 4; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        const b = await getPayoutBatch(payment.payoutBatchId);
        console.log(`   PayPal batch ${payment.payoutBatchId}: ${b.batch_header.batch_status}`);
        if (!["PENDING", "PROCESSING"].includes(b.batch_header.batch_status)) break;
      }
    }
  }

  console.log(`\nRESULT: ${finalOutcome}${r.error ? ` (${r.error})` : ""}`);
} catch (e) {
  printError(e);
  process.exit(1);
}