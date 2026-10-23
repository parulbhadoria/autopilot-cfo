import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryLedger } from "@autopilot/guardrail";
import { createApp } from "./app.js";
import { createChannel3FromEnv, createMarketLookup } from "./channel3/index.js";
import { config } from "./config.js";
import { createLlmFromEnv, createToolChatFromEnv } from "./llm/index.js";
import { createLlmBuyer, createRuleBuyer } from "./negotiation/index.js";
import { PaymentStore } from "./payments/store.js";
import { createPayoutsClient } from "./paypal/payouts.js";
import { verifyWebhookSignature } from "./paypal/webhook.js";
import { Seller } from "./seller/index.js";

const vendorEmail = config.vendorEmail();
if (!vendorEmail) console.warn("VENDOR_EMAIL is not set; the demo vendor will use vendor@example.com (payouts to it will not reach you).");
const seller = new Seller({ vendor: { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: vendorEmail || "vendor@example.com" } });

const chat = createToolChatFromEnv();
const channel3 = createChannel3FromEnv();
const market = channel3 ? createMarketLookup(channel3) : undefined;
console.log(`Buyer: ${chat ? "LLM (Groq)" : "rule-based (no GROQ_API_KEY)"} | market prices: ${market ? "Channel3" : "off"}`);

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const staticDir = existsSync(resolve(webDist, "index.html")) ? webDist : undefined;
console.log(staticDir ? `Web UI: serving ${webDist}` : "Web UI: not built (run `npm run build:web`, or use `npm run dev:all` for development)");

const app = createApp({
  staticDir,
  ledger: new InMemoryLedger(),
  store: new PaymentStore(),
  payouts: createPayoutsClient(),
  verifyWebhook: verifyWebhookSignature,
  llm: createLlmFromEnv(),
  adminApiKey: config.adminApiKey(),
  hardMaxWeeklyCents: config.hardMaxWeeklyCents(),
  purchase: {
    seller,
    market,
    makeBuyer: (a) => (chat ? createLlmBuyer({ chat, ...a }) : createRuleBuyer({ maxUnitPriceCents: a.maxUnitPriceCents })),
  },
});

app.listen(config.port(), () => console.log(`Autopilot CFO server on http://localhost:${config.port()}`));