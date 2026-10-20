// Sends a forged "payout succeeded" webhook to the local server. It MUST be rejected with 401.
// Start the server first:  npm run dev   then in another terminal:  npm run webhook:forged
import { config } from "../config.js";

const url = `http://localhost:${config.port()}/webhooks/paypal`;
const forged = {
  id: "WH-FORGED-1",
  event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  resource: { payout_batch_id: "ANYTHING", transaction_status: "SUCCESS" },
};

async function post(label: string, headers: Record<string, string>) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(forged) });
  console.log(`${label}: HTTP ${res.status}`, await res.text());
  return res.status;
}

const a = await post("No signature headers     ", {});
const b = await post("Fake signature headers   ", {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FAKE",
  "paypal-transmission-id": "fake-id",
  "paypal-transmission-sig": "ZmFrZQ==",
  "paypal-transmission-time": new Date().toISOString(),
});
const pass = a === 401 && b === 401;
console.log(pass ? "\nPASS: forged webhooks rejected." : "\nFAIL: a forged webhook was not rejected!");
process.exit(pass ? 0 : 1);
