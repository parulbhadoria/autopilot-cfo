// Manage the PayPal webhook for this app from the command line (sandbox).
//   npm run webhook:admin -- list
//   npm run webhook:admin -- register https://YOUR-APP.onrender.com/webhooks/paypal
// `register` creates the webhook and prints the Webhook ID to put in PAYPAL_WEBHOOK_ID.
import "../config.js"; // loads .env
import { paypalFetch, printError } from "../paypal/client.js";
import { WEBHOOK_EVENTS } from "../paypal/webhookEvents.js";

const [command, url] = process.argv.slice(2);

try {
  if (command === "list") {
    const r = await paypalFetch("/v1/notifications/webhooks");
    const hooks: any[] = r.webhooks ?? [];
    if (hooks.length === 0) console.log("No webhooks registered for this app.");
    for (const h of hooks) {
      const names: string[] = (h.event_types ?? []).map((e: any) => e.name);
      const missing = WEBHOOK_EVENTS.filter((e) => !names.includes(e) && !names.includes("*"));
      console.log(`${h.id}\n  url:    ${h.url}\n  events: ${names.length}${names.includes("*") ? " (all)" : ""}${missing.length ? `\n  MISSING: ${missing.join(", ")}` : "\n  all payout events covered"}`);
    }
  } else if (command === "register") {
    if (!url || !/^https:\/\//.test(url)) {
      console.error("Usage: npm run webhook:admin -- register https://YOUR-PUBLIC-URL/webhooks/paypal   (must be https)");
      process.exit(1);
    }
    const r = await paypalFetch("/v1/notifications/webhooks", {
      method: "POST",
      body: { url, event_types: WEBHOOK_EVENTS.map((name) => ({ name })) },
    });
    console.log(`Webhook created.\n  id:  ${r.id}\n  url: ${r.url}\n\nPut this in your environment:\n  PAYPAL_WEBHOOK_ID=${r.id}`);
  } else {
    console.error("Usage: npm run webhook:admin -- list | register <https-url>");
    process.exit(1);
  }
} catch (e) {
  printError(e);
  process.exit(1);
}