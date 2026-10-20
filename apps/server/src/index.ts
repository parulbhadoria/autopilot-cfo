import { InMemoryLedger } from "@autopilot/guardrail";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { createLlmFromEnv } from "./llm/index.js";
import { PaymentStore } from "./payments/store.js";
import { createPayoutsClient } from "./paypal/payouts.js";
import { verifyWebhookSignature } from "./paypal/webhook.js";

const app = createApp({
  ledger: new InMemoryLedger(),
  store: new PaymentStore(),
  payouts: createPayoutsClient(),
  verifyWebhook: verifyWebhookSignature,
  llm: createLlmFromEnv(),
  adminApiKey: config.adminApiKey(),
  hardMaxWeeklyCents: config.hardMaxWeeklyCents(),
});

app.listen(config.port(), () => console.log(`Autopilot CFO server on http://localhost:${config.port()}`));
