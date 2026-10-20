import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { paypalFetch, printError } from "../paypal/client.js";

// Usage: npm run paypal:payout -- [vendorEmail] [amount]
const email = process.argv[2] ?? config.vendorEmail();
const amount = process.argv[3] ?? "5.00";
if (!email) {
  console.error("Provide a vendor email arg or set VENDOR_EMAIL in .env");
  process.exit(1);
}

try {
  const batchId = `batch-${randomUUID()}`;
  const created = await paypalFetch("/v1/payments/payouts", {
    method: "POST",
    requestId: batchId,
    body: {
      sender_batch_header: {
        sender_batch_id: batchId,
        email_subject: "Autopilot CFO test payment",
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: email,
          amount: { value: amount, currency: "USD" },
          note: "Day 1 test payout",
          sender_item_id: `item-${randomUUID()}`,
        },
      ],
    },
  });

  const id = created.batch_header.payout_batch_id;
  console.log("Payout batch created:", id, "status:", created.batch_header.batch_status);

  // Poll briefly for the final status
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await paypalFetch(`/v1/payments/payouts/${id}`);
    const item = s.items?.[0];
    console.log(`batch: ${s.batch_header.batch_status} | item: ${item?.transaction_status ?? "n/a"}`);
    if (!["PENDING", "PROCESSING"].includes(s.batch_header.batch_status)) break;
  }
} catch (e) {
  printError(e);
  process.exit(1);
}
