import { randomUUID } from "node:crypto";
import { paypalFetch, printError } from "../paypal/client.js";

try {
  const order = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    requestId: randomUUID(),
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "demo-flour-001",
          description: "25kg flour (Day 1 test)",
          amount: { currency_code: "USD", value: "10.00" },
        },
      ],
    },
  });

  const approve = order.links?.find((l: any) => l.rel === "approve" || l.rel === "payer-action");
  console.log("Order created:", order.id, "status:", order.status);
  console.log("\nOpen this link, log in with your sandbox PERSONAL account, and approve:");
  console.log(approve?.href ?? "(no approve link found, inspect response)");
  console.log(`\nThen run:  npm run paypal:capture -- ${order.id}`);
} catch (e) {
  printError(e);
  process.exit(1);
}
