import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryLedger, MandateSchema } from "@autopilot/guardrail";
import { reconcileOnce, startReconciler } from "../src/payments/reconciler.js";
import { submitPayment } from "../src/payments/service.js";
import { PaymentStore } from "../src/payments/store.js";
import type { PayoutsClient } from "../src/paypal/payouts.js";

const mandate = MandateSchema.parse({
  mandateId: "m1", currency: "USD", weeklyBudgetCents: 40_000, perTransactionCapCents: 40_000, autoApproveUnderCents: 10_000,
  categories: ["sheet pans"], vendors: [{ vendorId: "sunrise", name: "Sunrise", payeeEmail: "vendor@example.com" }],
});
// Two payments to one vendor within a day add up for the order-splitting rule, so tests that need several
// payments in flight at once use a mandate whose auto-approve line is high enough.
const roomy = MandateSchema.parse({ ...mandate, autoApproveUnderCents: 40_000 });
const deal = (id: string, total = 9_000) => ({
  dealId: id, negotiationId: `n-${id}`, vendorId: "sunrise", payeeEmail: "vendor@example.com", category: "sheet pans", quantity: 4,
  unitPriceCents: total / 4, shippingCents: 0, otherFeesCents: 0, totalCents: total, currency: "USD", expiresAt: Date.now() + 600_000,
});

/** Per-batch item statuses we control, plus a count of PayPal lookups. */
function setup() {
  const items = new Map<string, string>();
  const calls: string[] = [];
  const failFor = new Set<string>();
  const payouts: PayoutsClient = {
    createPayout: async (a) => {
      const id = `B-${a.senderBatchId}`;
      items.set(id, "PENDING");
      return { payoutBatchId: id, batchStatus: "PENDING" };
    },
    getBatch: async (id) => {
      calls.push(id);
      if (failFor.has(id)) throw new Error("PayPal down");
      return { batchStatus: "SUCCESS", items: [{ payoutItemId: `I-${id}`, status: items.get(id) ?? "PENDING" }] };
    },
  };
  const deps = { ledger: new InMemoryLedger(), store: new PaymentStore(), payouts };
  return { deps, items, calls, failFor };
}

afterEach(() => vi.useRealTimers());

describe("reconcileOnce", () => {
  it("brings in-flight payments up to date and leaves finished ones alone", async () => {
    const { deps, items, calls } = setup();
    const a = await submitPayment(deps, roomy, deal("a"));
    const b = await submitPayment(deps, roomy, deal("b", 8_000));
    items.set(a.payoutBatchId!, "SUCCESS");
    items.set(b.payoutBatchId!, "PENDING");

    const r1 = await reconcileOnce(deps);
    expect(r1).toEqual({ checked: 2, changed: 2, errors: 0 }); // both learn PayPal's item status
    expect(deps.store.get(a.paymentId)?.status).toBe("SUCCESS");
    expect(deps.store.get(b.paymentId)?.status).toBe("PROCESSING");

    calls.length = 0;
    const r2 = await reconcileOnce(deps);
    expect(r2).toEqual({ checked: 1, changed: 0, errors: 0 }); // only b is still in flight, and nothing changed
    expect(calls).toEqual([b.payoutBatchId]);
  });

  it("makes no PayPal calls when nothing is in flight", async () => {
    const { deps, calls } = setup();
    expect(await reconcileOnce(deps)).toEqual({ checked: 0, changed: 0, errors: 0 });
    expect(calls).toEqual([]);
  });

  it("skips payments that were never sent and payments older than the cut-off", async () => {
    const { deps, calls } = setup();
    await submitPayment(deps, mandate, deal("held", 14_000)); // needs approval, never sent
    const old = await submitPayment(deps, mandate, deal("old"));
    deps.store.update(old.paymentId, { createdAt: Date.now() - 60 * 60_000 });
    expect(await reconcileOnce(deps, { maxAgeMs: 30 * 60_000 })).toEqual({ checked: 0, changed: 0, errors: 0 });
    expect(calls).toEqual([]);
  });

  it("one failing lookup does not stop the others", async () => {
    const { deps, items, failFor } = setup();
    const a = await submitPayment(deps, roomy, deal("a"));
    const b = await submitPayment(deps, roomy, deal("b", 8_000));
    failFor.add(a.payoutBatchId!);
    items.set(b.payoutBatchId!, "SUCCESS");
    expect(await reconcileOnce(deps)).toEqual({ checked: 2, changed: 1, errors: 1 });
    expect(deps.store.get(b.paymentId)?.status).toBe("SUCCESS");
    expect(deps.store.get(a.paymentId)?.status).toBe("PROCESSING");
  });

  it("frees the budget when PayPal reports the payout came back", async () => {
    const { deps, items } = setup();
    const a = await submitPayment(deps, mandate, deal("a"));
    items.set(a.payoutBatchId!, "RETURNED");
    await reconcileOnce(deps);
    expect(deps.store.get(a.paymentId)?.status).toBe("REVERSED");
    expect(deps.ledger.has("a")).toBe(false);
  });
});

describe("startReconciler", () => {
  it("checks on a timer until stopped", async () => {
    vi.useFakeTimers();
    const { deps, items, calls } = setup();
    const a = await submitPayment(deps, mandate, deal("a"));
    const stop = startReconciler(deps, { intervalMs: 10_000 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    items.set(a.payoutBatchId!, "SUCCESS");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.store.get(a.paymentId)?.status).toBe("SUCCESS");

    const before = calls.length;
    await vi.advanceTimersByTimeAsync(30_000); // nothing in flight any more
    expect(calls.length).toBe(before);
    stop();
  });

  it("stop() really stops it", async () => {
    vi.useFakeTimers();
    const { deps, calls } = setup();
    await submitPayment(deps, mandate, deal("a"));
    const stop = startReconciler(deps, { intervalMs: 5_000 });
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
  });

  it("is off when the interval is 0", async () => {
    vi.useFakeTimers();
    const { deps, calls } = setup();
    await submitPayment(deps, mandate, deal("a"));
    startReconciler(deps, { intervalMs: 0 })();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
  });

  it("never runs two passes at once, even when PayPal is slow", async () => {
    vi.useFakeTimers();
    const { deps } = setup();
    let inFlight = 0;
    let maxInFlight = 0;
    deps.payouts.getBatch = async (id) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 25_000)); // slower than the interval
      inFlight--;
      return { batchStatus: "SUCCESS", items: [{ payoutItemId: "I", status: "PENDING" }] };
    };
    await submitPayment(deps, mandate, deal("a"));
    const stop = startReconciler(deps, { intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    stop();
    expect(maxInFlight).toBe(1);
  });

  it("logs only when something changed or failed", async () => {
    vi.useFakeTimers();
    const { deps, items } = setup();
    const a = await submitPayment(deps, mandate, deal("a"));
    const log = vi.fn();
    const stop = startReconciler(deps, { intervalMs: 10_000, log });
    await vi.advanceTimersByTimeAsync(10_000); // first pass learns the item status: a change
    expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); // nothing new
    expect(log).toHaveBeenCalledTimes(1);
    items.set(a.payoutBatchId!, "SUCCESS");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toHaveBeenCalledTimes(2);
    stop();
  });
});