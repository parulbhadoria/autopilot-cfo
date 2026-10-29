import request from "supertest";
import { describe, expect, it } from "vitest";
import { InMemoryLedger, MandateSchema } from "@autopilot/guardrail";
import { createApp } from "../src/app.js";
import { PayPalError } from "../src/paypal/client.js";
import type { CreatePayoutArgs, PayoutsClient } from "../src/paypal/payouts.js";
import { PaymentActionError, approvePayment, cancelPayment, markRefundReceived, rejectPayment, requestRefund, submitPayment, syncPayment } from "../src/payments/service.js";
import { PaymentStore } from "../src/payments/store.js";

const mandate = MandateSchema.parse({
  mandateId: "m1", currency: "USD", weeklyBudgetCents: 40_000, perTransactionCapCents: 40_000, autoApproveUnderCents: 10_000,
  categories: ["sheet pans"], vendors: [{ vendorId: "sunrise", name: "Sunrise", payeeEmail: "vendor@example.com" }],
});
const deal = (id: string, total = 9_800) => ({
  dealId: id, negotiationId: `n-${id}`, vendorId: "sunrise", payeeEmail: "vendor@example.com", category: "sheet pans", quantity: 4,
  unitPriceCents: total / 4, shippingCents: 0, otherFeesCents: 0, totalCents: total, currency: "USD", expiresAt: Date.now() + 600_000,
});

/** A fake PayPal whose payout item status we control from the test. */
function setup(initialItemStatus = "SUCCESS") {
  const state = { item: initialItemStatus, batch: "SUCCESS", cancelled: [] as string[], batchCalls: 0, noBatchApi: false, cancelFails: false, cancel500: null as null | "went-through" | "not-done" };
  const created: CreatePayoutArgs[] = [];
  const payouts: PayoutsClient = {
    createPayout: async (a) => (created.push(a), { payoutBatchId: `B-${a.senderBatchId}`, batchStatus: "PENDING" }),
    getBatch: async () => {
      state.batchCalls++;
            return { batchStatus: state.batch, items: [{ payoutItemId: "ITEM1", status: state.item }] };
    },
    cancelItem: async (id) => {
            // The real PayPal sandbox enforces this: BATCH_NOT_COMPLETED until the whole batch is processed.
      if (state.batch !== "SUCCESS") throw new PayPalError("cancel failed", 400, { name: "BATCH_NOT_COMPLETED", message: "Only item belonging to a batch in Processed status can be cancelled." }, "dbg");
      if (state.cancel500) {
        // The real sandbox sometimes answers 500. Either it did the cancel anyway, or it did nothing.
        const mode = state.cancel500;
        state.cancel500 = null;
        if (mode === "went-through") state.item = "RETURNED";
        throw new PayPalError("internal", 500, { name: "INTERNAL_SERVICE_ERROR", message: "An internal service error has occurred" }, "dbg");
      }
      if (state.cancelFails) throw new PayPalError("cancel failed", 400, { message: "ITEM_NOT_UNCLAIMED" }, "dbg");
      state.cancelled.push(id);
      state.item = "RETURNED";
      return { status: "RETURNED" };
    },
  };
  if (state.noBatchApi) delete payouts.getBatch;
  const deps = { ledger: new InMemoryLedger(), store: new PaymentStore(), payouts };
  return { deps, state, created };
}
const paid = async (deps: any, id = "d1") => submitPayment(deps, mandate, deal(id));

describe("syncPayment", () => {
  it("moves PROCESSING to SUCCESS and remembers PayPal's item id and status", async () => {
    const { deps } = setup("SUCCESS");
    const p = await paid(deps);
    expect(p.status).toBe("PROCESSING");
    const s = await syncPayment(deps, p.paymentId);
    expect(s).toMatchObject({ status: "SUCCESS", payoutItemId: "ITEM1", payoutItemStatus: "SUCCESS" });
    expect(s.events.at(-1)).toMatchObject({ type: "synced_with_paypal", detail: "payout item SUCCESS, batch SUCCESS" });
    expect(s.payoutBatchStatus).toBe("SUCCESS");
  });

  it("does nothing, and logs nothing, when nothing changed", async () => {
    const { deps } = setup("SUCCESS");
    const p = await paid(deps);
    await syncPayment(deps, p.paymentId);
    const n = deps.store.get(p.paymentId)!.events.length;
    await syncPayment(deps, p.paymentId);
    expect(deps.store.get(p.paymentId)!.events.length).toBe(n);
  });

  it("keeps PROCESSING while PayPal is pending or the recipient has not claimed", async () => {
    for (const item of ["PENDING", "UNCLAIMED", "ONHOLD"]) {
      const { deps } = setup(item);
      const p = await paid(deps);
      const s = await syncPayment(deps, p.paymentId);
      expect(s.status).toBe("PROCESSING");
      expect(s.payoutItemStatus).toBe(item);
      expect(deps.ledger.has("d1")).toBe(true);
    }
  });

  it("frees the weekly budget when PayPal says the payout failed or came back", async () => {
    for (const [item, status] of [["FAILED", "FAILED"], ["BLOCKED", "FAILED"], ["RETURNED", "REVERSED"], ["REFUNDED", "REVERSED"]] as const) {
      const { deps } = setup(item);
      const p = await paid(deps);
      expect(deps.ledger.has("d1")).toBe(true);
      expect((await syncPayment(deps, p.paymentId)).status).toBe(status);
      expect(deps.ledger.has("d1")).toBe(false);
    }
  });

  it("resolves UNKNOWN to PROCESSING once PayPal confirms it has the payout", async () => {
    const { deps } = setup("PENDING");
    const p = await paid(deps);
    deps.store.update(p.paymentId, { status: "UNKNOWN" });
    expect((await syncPayment(deps, p.paymentId)).status).toBe("PROCESSING");
  });

  it("leaves payments that were never sent alone, and refuses unknown ids", async () => {
    const { deps } = setup();
    const held = await submitPayment(deps, mandate, deal("big", 14_000));
    expect(held.status).toBe("PENDING_APPROVAL");
    expect((await syncPayment(deps, held.paymentId)).status).toBe("PENDING_APPROVAL");
    expect(deps.store.get(held.paymentId)!.events.some((e) => e.type === "synced_with_paypal")).toBe(false);
    await expect(syncPayment(deps, "pay_nope")).rejects.toMatchObject({ status: 404 });
  });

  it("says so when the provider cannot look up status", async () => {
    const { deps } = setup();
    delete (deps.payouts as any).getBatch;
    const p = await paid(deps);
    await expect(syncPayment(deps, p.paymentId)).rejects.toMatchObject({ status: 501 });
  });
});

describe("cancelPayment (unclaimed payouts only)", () => {
  it("cancels an unclaimed payout with PayPal, marks it reversed and frees the budget", async () => {
    const { deps, state } = setup("UNCLAIMED");
    const p = await paid(deps);
    const c = await cancelPayment(deps, p.paymentId);
    expect(state.cancelled).toEqual(["ITEM1"]);
    expect(c).toMatchObject({ status: "REVERSED", payoutItemStatus: "RETURNED" });
    expect(c.events.at(-1)?.type).toBe("payout_cancelled");
    expect(deps.ledger.has("d1")).toBe(false);
  });

 it("waits for PayPal to finish the batch first: an unclaimed item in an unfinished batch is not cancelled yet", async () => {
    const { deps, state } = setup("UNCLAIMED");
    state.batch = "PROCESSING"; // exactly what the real sandbox showed: item UNCLAIMED, batch still PROCESSING
    const p = await paid(deps);
    await expect(cancelPayment(deps, p.paymentId)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/still finishing this payout batch/i) });
    expect(state.cancelled).toEqual([]);
    expect(deps.store.get(p.paymentId)).toMatchObject({ status: "PROCESSING", payoutItemStatus: "UNCLAIMED", payoutBatchStatus: "PROCESSING" });
    expect(deps.ledger.has("d1")).toBe(true);

    state.batch = "SUCCESS"; // PayPal finishes the batch
    const c = await cancelPayment(deps, p.paymentId);
    expect(state.cancelled).toEqual(["ITEM1"]);
    expect(c.status).toBe("REVERSED");
  });

  it("refuses to cancel when the batch itself was denied or cancelled", async () => {
    const { deps, state } = setup("UNCLAIMED");
    state.batch = "DENIED";
    const p = await paid(deps);
    await expect(cancelPayment(deps, p.paymentId)).rejects.toThrow(/batch is denied/i);
    expect(state.cancelled).toEqual([]);
  });
  it("after a PayPal 500, checks whether the cancel went through, and if so reports success", async () => {
    const { deps, state } = setup("UNCLAIMED");
    const p = await paid(deps);
    state.cancel500 = "went-through";
    const c = await cancelPayment(deps, p.paymentId);
    expect(c).toMatchObject({ status: "REVERSED", payoutItemStatus: "RETURNED" });
    expect(deps.ledger.has("d1")).toBe(false);
  });

  it("after a PayPal 500 that did nothing, changes nothing, says so plainly, and a retry works", async () => {
    const { deps, state } = setup("UNCLAIMED");
    const p = await paid(deps);
    state.cancel500 = "not-done";
    await expect(cancelPayment(deps, p.paymentId)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/temporary error.*not cancelled/i) });
    expect(deps.store.get(p.paymentId)).toMatchObject({ status: "PROCESSING", payoutItemStatus: "UNCLAIMED" });
    expect(deps.ledger.has("d1")).toBe(true);
    expect((await cancelPayment(deps, p.paymentId)).status).toBe("REVERSED");
    expect(state.cancelled).toEqual(["ITEM1"]);
  });

  it("refuses a delivered payout, explains why, and never calls PayPal's cancel", async () => {
    const { deps, state } = setup("SUCCESS");
    const p = await paid(deps);
    await expect(cancelPayment(deps, p.paymentId)).rejects.toThrow(/already delivered.*cannot reverse/i);
    expect(state.cancelled).toEqual([]);
    expect(deps.ledger.has("d1")).toBe(true);
  });

  it("tells the owner to wait while PayPal is still processing", async () => {
    const { deps, state } = setup("PENDING");
    const p = await paid(deps);
    await expect(cancelPayment(deps, p.paymentId)).rejects.toThrow(/still processing/i);
    expect(state.cancelled).toEqual([]);
  });

  it("refuses payments that were never sent", async () => {
    const { deps } = setup();
    const held = await submitPayment(deps, mandate, deal("big", 14_000));
    await expect(cancelPayment(deps, held.paymentId)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/never sent/i) });
  });

  it("does not mark anything reversed when PayPal itself refuses the cancel", async () => {
    const { deps, state } = setup("UNCLAIMED");
    const p = await paid(deps);
    state.cancelFails = true;
    await expect(cancelPayment(deps, p.paymentId)).rejects.toBeInstanceOf(PayPalError);
    expect(deps.store.get(p.paymentId)!.status).toBe("PROCESSING");
    expect(deps.ledger.has("d1")).toBe(true);
  });

  it("says so when the provider cannot cancel", async () => {
    const { deps } = setup("UNCLAIMED");
    delete (deps.payouts as any).cancelItem;
    const p = await paid(deps);
    await expect(cancelPayment(deps, p.paymentId)).rejects.toMatchObject({ status: 501 });
  });
});

describe("refund request for a delivered payout (bookkeeping only)", () => {
  it("records a request, keeps the budget used, and moves no money", async () => {
    const { deps, state } = setup("SUCCESS");
    const p = await paid(deps);
    const r = await requestRefund(deps, p.paymentId, "  Wrong pans delivered  ");
    expect(r.status).toBe("SUCCESS");
    expect(r.refund).toMatchObject({ state: "REQUESTED", reason: "Wrong pans delivered" });
    expect(r.events.at(-1)).toMatchObject({ type: "refund_requested", detail: "Wrong pans delivered" });
    expect(state.cancelled).toEqual([]);
    expect(deps.ledger.has("d1")).toBe(true);
  });

  it("syncs first, so a payout PayPal already delivered can be refunded without a manual refresh", async () => {
    const { deps } = setup("SUCCESS");
    const p = await paid(deps);
    expect(p.status).toBe("PROCESSING");
    expect((await requestRefund(deps, p.paymentId)).refund?.state).toBe("REQUESTED");
  });

  it("only works on delivered payments, and only once", async () => {
    const { deps } = setup("UNCLAIMED");
    const p = await paid(deps);
    await expect(requestRefund(deps, p.paymentId)).rejects.toMatchObject({ status: 409 });
    const done = setup("SUCCESS");
    const q = await paid(done.deps);
    await requestRefund(done.deps, q.paymentId);
    await expect(requestRefund(done.deps, q.paymentId)).rejects.toThrow(/already requested/i);
  });

  it("caps the reason length", async () => {
    const { deps } = setup("SUCCESS");
    const p = await paid(deps);
    expect((await requestRefund(deps, p.paymentId, "x".repeat(1_000))).refund?.reason).toHaveLength(300);
  });

  it("once the owner confirms the money is back, it is reversed and the budget is freed", async () => {
    const { deps } = setup("SUCCESS");
    const p = await paid(deps);
    await expect(markRefundReceived(deps, p.paymentId)).rejects.toMatchObject({ status: 409 });
    await requestRefund(deps, p.paymentId);
    const r = await markRefundReceived(deps, p.paymentId);
    expect(r).toMatchObject({ status: "REVERSED", refund: { state: "RECEIVED" } });
    expect(r.refund?.receivedAt).toBeTypeOf("number");
    expect(deps.ledger.has("d1")).toBe(false);
    await expect(markRefundReceived(deps, p.paymentId)).rejects.toMatchObject({ status: 409 });
  });
});

describe("state errors on approve and reject are 409/404, not crashes", () => {
  it("uses PaymentActionError", async () => {
    const { deps } = setup();
    const p = await paid(deps);
    await expect(approvePayment(deps, mandate, p.paymentId)).rejects.toBeInstanceOf(PaymentActionError);
    expect(() => rejectPayment(deps, p.paymentId)).toThrow(/not PENDING_APPROVAL/);
    expect(() => rejectPayment(deps, "pay_nope")).toThrowError(expect.objectContaining({ status: 404 }));
  });
});

describe("HTTP endpoints", () => {
  function api(itemStatus: string) {
    const s = setup(itemStatus);
    const app = createApp({ ledger: s.deps.ledger, store: s.deps.store, payouts: s.deps.payouts, verifyWebhook: async () => true, mandate });
    return { app, ...s };
  }
  const pay = (app: any, id: string, total = 9_800) => request(app).post("/api/pay").send({ deal: deal(id, total) });

  it("sync, cancel, refund-request and refund-received work end to end", async () => {
    const { app } = api("UNCLAIMED");
    const made = await pay(app, "d1");
    const id = made.body.paymentId;
    const synced = await request(app).post(`/api/payments/${id}/sync`);
    expect(synced.body).toMatchObject({ status: "PROCESSING", payoutItemStatus: "UNCLAIMED" });
    const cancelled = await request(app).post(`/api/payments/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("REVERSED");

    const b = api("SUCCESS");
    const id2 = (await pay(b.app, "d2")).body.paymentId;
    expect((await request(b.app).post(`/api/payments/${id2}/refund-request`).send({ reason: "damaged" })).body.refund).toMatchObject({ state: "REQUESTED", reason: "damaged" });
    expect((await request(b.app).post(`/api/payments/${id2}/refund-received`)).body).toMatchObject({ status: "REVERSED", refund: { state: "RECEIVED" } });
  });

  it("answers 409 with a plain explanation, 404 for unknown ids", async () => {
    const { app } = api("SUCCESS");
    const id = (await pay(app, "d1")).body.paymentId;
    const res = await request(app).post(`/api/payments/${id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already delivered/i);
    expect((await request(app).post("/api/payments/pay_nope/cancel")).status).toBe(404);
    expect((await request(app).post(`/api/payments/${id}/refund-received`)).status).toBe(409);
    expect((await request(app).post(`/api/payments/${id}/approve`)).status).toBe(409);
  });
  
  it("answers 503 with a plain message when PayPal has a temporary error", async () => {
    const { app, state } = api("UNCLAIMED");
    const id = (await pay(app, "d1")).body.paymentId;
    state.cancel500 = "not-done";
    const res = await request(app).post(`/api/payments/${id}/cancel`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/temporary error/i);
  });

  it("reports PayPal's refusal as 502 with PayPal's own message", async () => {
    const { app, state } = api("UNCLAIMED");
    const id = (await pay(app, "d1")).body.paymentId;
    state.cancelFails = true;
    const res = await request(app).post(`/api/payments/${id}/cancel`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("PayPal said: ITEM_NOT_UNCLAIMED");
  });
});