import request from "supertest";
import { describe, expect, it } from "vitest";
import { InMemoryLedger, MandateSchema } from "@autopilot/guardrail";
import { createApp } from "../src/app.js";
import { PaymentStore } from "../src/payments/store.js";
import { BATCH_STATUS_BY_EVENT, ITEM_STATUS_BY_EVENT, WEBHOOK_EVENTS } from "../src/paypal/webhookEvents.js";

const mandate = MandateSchema.parse({
  mandateId: "m1", currency: "USD", weeklyBudgetCents: 40_000, perTransactionCapCents: 40_000, autoApproveUnderCents: 10_000,
  categories: ["sheet pans"], vendors: [{ vendorId: "sunrise", name: "Sunrise", payeeEmail: "vendor@example.com" }],
});
const deal = (id: string) => ({
  dealId: id, negotiationId: `n-${id}`, vendorId: "sunrise", payeeEmail: "vendor@example.com", category: "sheet pans", quantity: 4,
  unitPriceCents: 2_450, shippingCents: 0, otherFeesCents: 0, totalCents: 9_800, currency: "USD", expiresAt: Date.now() + 600_000,
});

function build() {
  const ledger = new InMemoryLedger();
  const store = new PaymentStore();
  const app = createApp({
    ledger, store, mandate,
    payouts: { createPayout: async (a) => ({ payoutBatchId: `BATCH-${a.senderBatchId}`, batchStatus: "PENDING" }) },
    verifyWebhook: async () => true,
  });
  return { app, ledger, store };
}
let n = 0;
const send = (app: any, type: string, resource: unknown) =>
  request(app).post("/webhooks/paypal").set("content-type", "application/json").send(JSON.stringify({ id: `WH-${++n}`, event_type: type, resource }));
const itemRes = (batch: string) => ({ payout_batch_id: batch, payout_item_id: "ITEM-9", transaction_status: "X" });
const batchRes = (batch: string) => ({ batch_header: { payout_batch_id: batch } });

describe("webhook events and payment status", () => {
  it("every subscribed event is understood: each is either an item event or a batch event", () => {
    for (const e of WEBHOOK_EVENTS) {
      const kinds = [e in ITEM_STATUS_BY_EVENT, e in BATCH_STATUS_BY_EVENT].filter(Boolean).length;
      expect({ e, kinds }).toEqual({ e, kinds: 1 });
    }
    expect(new Set(WEBHOOK_EVENTS).size).toBe(WEBHOOK_EVENTS.length);
  });

  it("a batch SUCCESS does not mark an UNCLAIMED payout as delivered (the real sandbox does exactly this)", async () => {
    const { app, store } = build();
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    const batch = paid.body.payoutBatchId;
    await send(app, "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", itemRes(batch));
    await send(app, "PAYMENT.PAYOUTSBATCH.SUCCESS", batchRes(batch));
    expect(store.get(paid.body.paymentId)).toMatchObject({ status: "PROCESSING", payoutItemStatus: "UNCLAIMED", payoutItemId: "ITEM-9", payoutBatchStatus: "SUCCESS" });
  });

  it("an item SUCCEEDED event marks it delivered and records PayPal's words", async () => {
    const { app, store } = build();
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    await send(app, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", itemRes(paid.body.payoutBatchId));
    expect(store.get(paid.body.paymentId)).toMatchObject({ status: "SUCCESS", payoutItemStatus: "SUCCESS", payoutItemId: "ITEM-9" });
    expect(store.get(paid.body.paymentId)!.events.at(-1)?.type).toBe("webhook:PAYMENT.PAYOUTS-ITEM.SUCCEEDED");
  });

  it("tracks the batch through PROCESSING to SUCCESS, so the app knows when an unclaimed payout becomes cancellable", async () => {
    const { app, store } = build();
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    const batch = paid.body.payoutBatchId;
    await send(app, "PAYMENT.PAYOUTSBATCH.PROCESSING", batchRes(batch));
    expect(store.get(paid.body.paymentId)?.payoutBatchStatus).toBe("PROCESSING");
    await send(app, "PAYMENT.PAYOUTSBATCH.SUCCESS", batchRes(batch));
    expect(store.get(paid.body.paymentId)?.payoutBatchStatus).toBe("SUCCESS");
  });

  it("RETURNED frees the weekly budget, and a late SUCCEEDED cannot undo it", async () => {
    const { app, store, ledger } = build();
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    const batch = paid.body.payoutBatchId;
    expect(ledger.has("d1")).toBe(true);
    await send(app, "PAYMENT.PAYOUTS-ITEM.RETURNED", itemRes(batch));
    expect(store.get(paid.body.paymentId)?.status).toBe("REVERSED");
    expect(ledger.has("d1")).toBe(false);
    await send(app, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", itemRes(batch)); // arrives late, out of order
    expect(store.get(paid.body.paymentId)?.status).toBe("REVERSED");
  });

  it("a failed item marks the payment failed and frees the budget", async () => {
    const { app, store, ledger } = build();
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    await send(app, "PAYMENT.PAYOUTS-ITEM.BLOCKED", itemRes(paid.body.payoutBatchId));
    expect(store.get(paid.body.paymentId)).toMatchObject({ status: "FAILED", payoutItemStatus: "BLOCKED" });
    expect(ledger.has("d1")).toBe(false);
  });

  it("HELD is recorded but leaves the payment in flight", async () => {
    const { app, store } = build();
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    await send(app, "PAYMENT.PAYOUTS-ITEM.HELD", itemRes(paid.body.payoutBatchId));
    expect(store.get(paid.body.paymentId)).toMatchObject({ status: "PROCESSING", payoutItemStatus: "HELD" });
  });
});