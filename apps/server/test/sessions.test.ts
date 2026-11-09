import { describe, expect, it } from "vitest";
import { InMemoryLedger, type Mandate } from "@autopilot/guardrail";
import { PaymentStore, type PaymentRecord } from "../src/payments/store.js";
import { PurchaseStore } from "../src/purchases/store.js";
import { DEFAULT_SESSION, SessionManager, isValidSessionId } from "../src/sessions.js";

const rec = (over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  paymentId: "pay_1", dealId: "d1", negotiationId: "n", vendorId: "v", payeeEmail: "v@example.com", amountCents: 100, currency: "USD",
  status: "PROCESSING", decision: "allow", summary: "", checks: [], deal: {}, request: {}, events: [], createdAt: 0, updatedAt: 0, ...over,
});
const fakeMandate = { mandateId: "m" } as Mandate;

describe("session ids", () => {
  it("accepts safe ids and rejects everything else", () => {
    for (const ok of ["abcdefgh", "a1b2c3d4-e5f6_7890", "x".repeat(64)]) expect(isValidSessionId(ok)).toBe(true);
    for (const bad of ["short", "x".repeat(65), "has space 123", "semi;colon1", "../../etc/passwd", "", undefined, 42, null]) expect(isValidSessionId(bad)).toBe(false);
  });
});

describe("SessionManager", () => {
  it("gives each id its own mandate, ledger, payments and purchases", () => {
    const m = new SessionManager();
    const a = m.get("visitor-aaaa");
    const b = m.get("visitor-bbbb");
    a.mandate = fakeMandate;
    a.ledger.add({ dealId: "d1", vendorId: "v", amountCents: 100, currency: "USD", at: 1 });
    a.store.create(rec());
    expect(m.get("visitor-aaaa")).toBe(a);
    expect(b.mandate).toBeNull();
    expect(b.ledger.has("d1")).toBe(false);
    expect(b.store.list()).toEqual([]);
    expect(b.purchases).not.toBe(a.purchases);
  });

  it("seeds only the default session", () => {
    const ledger = new InMemoryLedger();
    const store = new PaymentStore();
    const purchases = new PurchaseStore();
    const m = new SessionManager({ seed: { ledger, store, purchases, mandate: fakeMandate } });
    const d = m.get(DEFAULT_SESSION);
    expect([d.ledger, d.store, d.purchases, d.mandate]).toEqual([ledger, store, purchases, fakeMandate]);
    const other = m.get("visitor-aaaa");
    expect(other.store).not.toBe(store);
    expect(other.mandate).toBeNull();
  });

  it("forgets idle sessions, but never the default one or one holding a live payment", () => {
    let t = 1_000_000;
    const m = new SessionManager({ ttlMs: 60_000, now: () => t });
    m.get(DEFAULT_SESSION);
    m.get("idle-visitor");
    m.get("busy-visitor").store.create(rec({ createdAt: t, payoutBatchId: "B1" }));
    t += 120_000; // everyone is now past the TTL
    m.get("new-visitor"); // any access sweeps
    expect(m.peek("idle-visitor")).toBeUndefined();
    expect(m.peek("busy-visitor")).toBeDefined();
    expect(m.peek(DEFAULT_SESSION)).toBeDefined();
  });

  it("stops protecting a payment that has been in flight for over an hour", () => {
    let t = 1_000_000;
    const m = new SessionManager({ ttlMs: 60_000, now: () => t });
    m.get("stuck-visitor").store.create(rec({ createdAt: t, payoutBatchId: "B1" }));
    t += 2 * 60 * 60_000;
    m.get("new-visitor");
    expect(m.peek("stuck-visitor")).toBeUndefined();
  });

  it("evicts the least recently used sessions past the maximum", () => {
    let t = 1_000;
    const m = new SessionManager({ maxSessions: 3, now: () => (t += 10) });
    m.get(DEFAULT_SESSION);
    m.get("visitor-1111");
    m.get("visitor-2222");
    m.get("visitor-1111"); // touch: 2222 is now the oldest
    m.get("visitor-3333");
    expect(m.size).toBe(3);
    expect(m.peek("visitor-2222")).toBeUndefined();
    expect(m.peek("visitor-1111")).toBeDefined();
    expect(m.peek(DEFAULT_SESSION)).toBeDefined();
  });

  it("finds a payment in whichever session owns it, by PayPal batch id or our sender batch id", () => {
    const m = new SessionManager();
    m.get("visitor-aaaa");
    m.get("visitor-bbbb").store.create(rec({ paymentId: "pay_b", payoutBatchId: "PAYPAL-1", senderBatchId: "cfo-d1" }));
    expect(m.findPayment("PAYPAL-1")?.session.id).toBe("visitor-bbbb");
    expect(m.findPayment("cfo-d1")?.rec.paymentId).toBe("pay_b");
    expect(m.findPayment("nope")).toBeUndefined();
  });

  it("reset starts that visitor over without touching anyone else", () => {
    const m = new SessionManager();
    m.get("visitor-aaaa").mandate = fakeMandate;
    m.get("visitor-bbbb").mandate = fakeMandate;
    const fresh = m.reset("visitor-aaaa");
    expect(fresh.mandate).toBeNull();
    expect(m.get("visitor-aaaa").mandate).toBeNull();
    expect(m.get("visitor-bbbb").mandate).toBe(fakeMandate);
  });
});
