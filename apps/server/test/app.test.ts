import request from "supertest";
import { describe, expect, it } from "vitest";
import { InMemoryLedger, MandateSchema } from "@autopilot/guardrail";
import { createApp } from "../src/app.js";
import { PaymentStore } from "../src/payments/store.js";
import type { PayoutsClient } from "../src/paypal/payouts.js";

const mandate = MandateSchema.parse({
  mandateId: "m1",
  currency: "USD",
  weeklyBudgetCents: 40_000,
  perTransactionCapCents: 20_000,
  autoApproveUnderCents: 10_000,
  categories: ["flour"],
  vendors: [{ vendorId: "v1", name: "Sunrise", payeeEmail: "vendor@example.com" }],
});

const deal = (id: string) => ({
  dealId: id,
  negotiationId: `n-${id}`,
  vendorId: "v1",
  payeeEmail: "vendor@example.com",
  category: "flour",
  quantity: 2,
  unitPriceCents: 4_400,
  shippingCents: 1_000,
  otherFeesCents: 0,
  totalCents: 9_800,
  currency: "USD",
  expiresAt: Date.now() + 600_000,
});

function build(opts: { signatureValid?: boolean; adminApiKey?: string; withMandate?: boolean } = {}) {
  const ledger = new InMemoryLedger();
  const store = new PaymentStore();
  const payouts: PayoutsClient = {
    createPayout: async (a) => ({ payoutBatchId: `BATCH-${a.senderBatchId}`, batchStatus: "PENDING" }),
  };
  const app = createApp({
    ledger,
    store,
    payouts,
    verifyWebhook: async () => opts.signatureValid ?? true,
    adminApiKey: opts.adminApiKey,
    mandate: opts.withMandate === false ? undefined : mandate,
  });
  return { app, ledger, store };
}

const hook = (app: any, event: unknown) =>
  request(app).post("/webhooks/paypal").set("content-type", "application/json").send(JSON.stringify(event));

describe("REST API", () => {
  it("pays via POST /api/pay and lists it", async () => {
    const { app } = build();
    const res = await request(app).post("/api/pay").send({ deal: deal("d1") });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PROCESSING");
    const list = await request(app).get("/api/payments");
    expect(list.body.payments).toHaveLength(1);
  });

  it("returns 409 when no mandate is active", async () => {
    const { app } = build({ withMandate: false });
    expect((await request(app).post("/api/pay").send({ deal: deal("d1") })).status).toBe(409);
  });

  it("rejects an invalid mandate with 400", async () => {
    const { app } = build();
    expect((await request(app).put("/api/mandate").send({ foo: 1 })).status).toBe(400);
  });

  it("enforces x-api-key when configured", async () => {
    const { app } = build({ adminApiKey: "secret" });
    expect((await request(app).get("/api/payments")).status).toBe(401);
    expect((await request(app).get("/api/payments").set("x-api-key", "secret")).status).toBe(200);
  });
});

describe("PayPal webhooks", () => {
  it("rejects forged/unsigned webhooks with 401 and changes nothing", async () => {
    const { app, store } = build({ signatureValid: false });
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    const res = await hook(app, {
      id: "WH-1",
      event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: { payout_batch_id: paid.body.payoutBatchId },
    });
    expect(res.status).toBe(401);
    expect(store.get(paid.body.paymentId)?.status).toBe("PROCESSING");
  });

  it("verified success event marks the payment SUCCESS; duplicates are ignored", async () => {
    const { app, store } = build();
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    const ev = { id: "WH-2", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_batch_id: paid.body.payoutBatchId, transaction_status: "SUCCESS" } };
    expect((await hook(app, ev)).body).toMatchObject({ handled: true, status: "SUCCESS" });
    expect(store.get(paid.body.paymentId)?.status).toBe("SUCCESS");
    expect((await hook(app, ev)).body).toMatchObject({ handled: false, reason: "duplicate" });
  });

  it("failed payout event releases the budget reservation", async () => {
    const { app, store, ledger } = build();
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    expect(ledger.has("d1")).toBe(true);
    await hook(app, { id: "WH-3", event_type: "PAYMENT.PAYOUTS-ITEM.FAILED", resource: { payout_batch_id: paid.body.payoutBatchId } });
    expect(store.get(paid.body.paymentId)?.status).toBe("FAILED");
    expect(ledger.has("d1")).toBe(false);
  });

  it("matches events by sender_batch_id from a batch event payload", async () => {
    const { app, store } = build();
    const paid = await request(app).post("/api/pay").send({ deal: deal("d1") });
    await hook(app, {
      id: "WH-4",
      event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
      resource: { batch_header: { payout_batch_id: "nope", sender_batch_header: { sender_batch_id: "cfo-d1" } } },
    });
      // A batch event only updates the batch: the item (and so the money) may still be unclaimed.
    expect(store.get(paid.body.paymentId)).toMatchObject({ status: "PROCESSING", payoutBatchStatus: "SUCCESS" });
  });

  it("returns 404 for unknown payouts (so PayPal retries) and ignores other event types", async () => {
    const { app } = build();
    expect((await hook(app, { id: "WH-5", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_batch_id: "ghost" } })).status).toBe(404);
    expect((await hook(app, { id: "WH-6", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} })).body.handled).toBe(false);
  });
});
