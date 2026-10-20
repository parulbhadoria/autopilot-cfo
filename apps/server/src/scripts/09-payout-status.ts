import "../config.js";
import { getPayoutBatch } from "../paypal/payouts.js";

const id = process.argv[2];
if (!id) {
  console.error("Usage: npm run payout:status -- <PAYOUT_BATCH_ID>");
  process.exit(1);
}
const b = await getPayoutBatch(id);
console.log("batch:", b.batch_header.batch_status);
for (const i of b.items ?? []) console.log("item:", i.transaction_status, i.errors?.message ?? "");