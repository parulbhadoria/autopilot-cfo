import { paypalFetch } from "./client.js";

export interface CreatePayoutArgs {
  senderBatchId: string;
  senderItemId: string;
  email: string;
  amountCents: number;
  currency: string;
  note: string;
}

export interface PayoutsClient {
  createPayout(args: CreatePayoutArgs): Promise<{ payoutBatchId: string; batchStatus: string }>;
}

export const centsToValue = (c: number) => (c / 100).toFixed(2);

export function createPayoutsClient(): PayoutsClient {
  return {
    async createPayout(a) {
      const res = await paypalFetch("/v1/payments/payouts", {
        method: "POST",
        // Deterministic ids derived from the deal: a retry can never pay twice.
        requestId: a.senderBatchId,
        body: {
          sender_batch_header: {
            sender_batch_id: a.senderBatchId,
            email_subject: "Payment from Autopilot CFO",
          },
          items: [
            {
              recipient_type: "EMAIL",
              receiver: a.email,
              amount: { value: centsToValue(a.amountCents), currency: a.currency },
              note: a.note,
              sender_item_id: a.senderItemId,
            },
          ],
        },
      });
      return { payoutBatchId: res.batch_header.payout_batch_id, batchStatus: res.batch_header.batch_status };
    },
  };
}

export async function getPayoutBatch(id: string) {
  return paypalFetch(`/v1/payments/payouts/${id}`);
}
