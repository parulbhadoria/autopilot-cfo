// Proves the cancel path against the real PayPal sandbox:
//   1. send $1.00 to an email that has no PayPal account  -> the payout waits as UNCLAIMED
//   2. cancel that payout                                  -> PayPal returns the money (RETURNED)
// A delivered payout (to a real sandbox account) cannot be reversed; this is the one case PayPal allows.
// Usage: npm run payout:cancel-demo
import "../config.js"; // loads .env
import { PayPalError, printError } from "../paypal/client.js";
import { createPayoutsClient } from "../paypal/payouts.js";

const payouts = createPayoutsClient();
const stamp = Date.now().toString(36);
const email = `nobody-${stamp}@example.com`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  console.log(`1) Sending $1.00 to ${email} (no PayPal account)...`);
  const created = await payouts.createPayout({
    senderBatchId: `cancel-demo-${stamp}`,
    senderItemId: `item-${stamp}`,
    email,
    amountCents: 100,
    currency: "USD",
    note: "Autopilot CFO cancel demo",
  });
  console.log(`   batch ${created.payoutBatchId} created (${created.batchStatus})`);

  // PayPal only allows a cancel once the item is UNCLAIMED AND the whole batch is processed (SUCCESS).
  // In the real sandbox the item turns UNCLAIMED first and the batch finishes a little later.
  let item: { payoutItemId: string; status: string } | undefined;
  let batchStatus = "";
  for (let i = 0; i < 30; i++) {
    await sleep(3_000);
    const b = await payouts.getBatch!(created.payoutBatchId);
    item = b.items[0];
    batchStatus = b.batchStatus;
    console.log(`   PayPal says: item ${item?.status ?? "(not listed yet)"}, batch ${batchStatus}`);
    if (item && !["PENDING", "ONHOLD"].includes(item.status) && !["PENDING", "PROCESSING"].includes(batchStatus)) break;
  }
  if (!item) throw new Error("PayPal did not list the payout item in time.");

  if (item.status !== "UNCLAIMED") {
    console.log(`\nThe item is ${item.status}, not UNCLAIMED, so PayPal will not allow a cancel. Nothing more to do.`);
    process.exit(0);
  }
  if (batchStatus !== "SUCCESS") {
    console.log(`\nThe batch is ${batchStatus}, not processed yet, so PayPal will not allow a cancel. Run the script again in a minute.`);
    process.exit(0);
  }

  console.log("2) Cancelling the unclaimed payout...");
    // PayPal's sandbox occasionally answers a cancel with a 500. Check whether it went through, then retry.
  let out: { status: string } | undefined;
  for (let attempt = 1; attempt <= 3 && !out; attempt++) {
    try {
      out = await payouts.cancelItem!(item.payoutItemId);
    } catch (e) {
      if (!(e instanceof PayPalError) || e.status < 500 || attempt === 3) throw e;
      console.log(`   PayPal had a temporary error (${e.status}). Checking whether it went through, then retrying...`);
      await sleep(3_000);
      const now = (await payouts.getBatch!(created.payoutBatchId)).items[0];
      if (now?.status === "RETURNED") out = { status: "RETURNED" };
    }
  }
  if (!out) throw new Error("The cancel did not complete.");
  console.log(`   PayPal says: ${out.status}`);
  const after = (await payouts.getBatch!(created.payoutBatchId)).items[0];
  console.log(`   Item is now: ${after?.status}`);
  console.log(out.status === "RETURNED" ? "\nOK: the money came back." : "\nUnexpected status. Paste this output to me.");
} catch (e) {
  printError(e);
  process.exit(1);
}