import { paypalFetch } from "./client.js";

export interface CreatePayoutArgs {
  senderBatchId: string;
  senderItemId: string;
  email: string;
  amountCents: number;
  currency: string;
  note: string;
}

export interface PayoutBatchInfo {
  batchStatus: string;
  items: { payoutItemId: string; status: string }[];
}

export interface PayoutsClient {
  createPayout(args: CreatePayoutArgs): Promise<{ payoutBatchId: string; batchStatus: string }>;
  /** Looks up a batch and the status of each payout item (SUCCESS, UNCLAIMED, PENDING, RETURNED...). */
  getBatch?(batchId: string): Promise<PayoutBatchInfo>;
  /** Cancels an UNCLAIMED payout item; PayPal returns the money. Fails for any other status. */
  cancelItem?(payoutItemId: string): Promise<{ status: string }>;
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

    async getBatch(batchId) {
      const b = await paypalFetch(`/v1/payments/payouts/${batchId}`);
      return {
        batchStatus: b.batch_header.batch_status,
        items: (b.items ?? []).map((i: any) => ({ payoutItemId: String(i.payout_item_id), status: String(i.transaction_status) })),
      };
    },

    async cancelItem(payoutItemId) {
      const r = await paypalFetch(`/v1/payments/payouts-item/${payoutItemId}/cancel`, { method: "POST", body: {} });
      return { status: String(r.transaction_status) };
    },
  };
}

export async function getPayoutBatch(id: string) {
  return paypalFetch(`/v1/payments/payouts/${id}`);
}