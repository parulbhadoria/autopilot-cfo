import { randomUUID } from "node:crypto";
import { paypalFetch, printError } from "../paypal/client.js";

const orderId = process.argv[2];
if (!orderId) {
  console.error("Usage: npm run paypal:capture -- <ORDER_ID>");
  process.exit(1);
}

try {
  const res = await paypalFetch(`/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    requestId: randomUUID(),
    body: {},
  });
  const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
  console.log("Order status:", res.status);
  console.log("Capture id:", cap?.id, "| amount:", cap?.amount?.value, cap?.amount?.currency_code);
} catch (e) {
  printError(e);
  process.exit(1);
}
