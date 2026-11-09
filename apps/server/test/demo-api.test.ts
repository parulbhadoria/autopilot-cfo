import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, DEFAULT_DEMO_LIMITS, type DemoConfig } from "../src/app.js";
import { createRuleBuyer } from "../src/negotiation/index.js";
import type { CreatePayoutArgs, PayoutsClient } from "../src/paypal/payouts.js";
import { Seller } from "../src/seller/index.js";
import { SessionManager } from "../src/sessions.js";

const vendor = { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: "vendor@example.com" };
const A = { "x-session-id": "visitor-aaaa" };
const B = { "x-session-id": "visitor-bbbb" };
const ip = (addr: string) => ({ "x-forwarded-for": addr });

function build(o: { demo?: Partial<DemoConfig> | false; adminApiKey?: string } = {}) {
  const sessions = new SessionManager();
  const payoutCalls: CreatePayoutArgs[] = [];
  const llmCalls = { n: 0 };
  const payouts: PayoutsClient = { createPayout: async (a) => (payoutCalls.push(a), { payoutBatchId: `B-${a.senderBatchId}`, batchStatus: "PENDING" }) };
  const app = createApp({
    sessions,
    payouts,
    verifyWebhook: async () => true,
    llm: { complete: async () => (llmCalls.n++, JSON.stringify({ weeklyBudget: 400, autoApproveUnder: 100, categories: ["flour", "sheet pans"] })) },
    adminApiKey: o.adminApiKey,
    demo: o.demo === false ? undefined : { ...DEFAULT_DEMO_LIMITS, ...o.demo },
    purchase: { seller: new Seller({ vendor }), makeBuyer: (a) => createRuleBuyer({ maxUnitPriceCents: a.maxUnitPriceCents }) },
  });
  return { app, sessions, payoutCalls, llmCalls };
}
const start = (app: any, headers: Record<string, string>) => request(app).post("/api/demo/start").set(headers);
const buy = (app: any, headers: Record<string, string>, body: object = { category: "sheet pans", quantity: 4 }) => request(app).post("/api/purchase").set(headers).send(body);

describe("demo mode basics", () => {
  it("reports whether it is a demo", async () => {
    expect((await request(build({ demo: false }).app).get("/api/demo")).body).toEqual({ demoMode: false });
    const r = await request(build().app).get("/api/demo").set(ip("9.9.9.9"));
    expect(r.body).toMatchObject({ demoMode: true, limits: { purchasesPerHour: 10, purchasesPerVisitorPerHour: 4 }, remaining: { purchases: 4 } });
  });

  it("turns off the developer endpoint that pays any deal", async () => {
    const { app } = build();
    await start(app, A);
    const res = await request(app).post("/api/pay").set(A).send({ deal: {} });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not available in the public demo/i);
  });

  it("keeps /api/pay working outside demo mode", async () => {
    const { app } = build({ demo: false });
    expect((await request(app).post("/api/pay").set(A).send({ deal: {} })).status).toBe(409); // no mandate yet, but the route exists
  });

  it("demo buttons exist only in demo mode", async () => {
    const { app } = build({ demo: false });
    expect((await start(app, A)).status).toBe(404);
    expect((await request(app).post("/api/demo/reset").set(A)).status).toBe(404);
  });

  it("sends safety headers on every response", async () => {
    const res = await request(build().app).get("/health");
    expect(res.headers).toMatchObject({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
  });

  it("still enforces the admin key when one is set", async () => {
    const { app } = build({ adminApiKey: "secret" });
    expect((await request(app).get("/api/demo")).status).toBe(401);
    expect((await request(app).get("/api/demo").set("x-api-key", "secret")).status).toBe(200);
  });
});

describe("one-click demo rules", () => {
  it("activates preset rules for the caller only, with the server's vendor and no AI call", async () => {
    const { app } = build();
    const r = await start(app, A);
    expect(r.status).toBe(200);
    expect(r.body.mandate).toMatchObject({ weeklyBudgetCents: 40_000, autoApproveUnderCents: 10_000, categories: ["flour", "butter", "sheet pans"], vendors: [vendor] });
    expect((await request(app).get("/api/mandate").set(A)).body.mandate?.mandateId).toBe(r.body.mandate.mandateId);
    expect((await request(app).get("/api/mandate").set(B)).body.mandate).toBeNull();
  });
});

describe("visitors are isolated from each other", () => {
  it("each visitor has their own budget: both can auto-pay, and neither sees the other's history", async () => {
    const { app, payoutCalls } = build();
    await start(app, A);
    await start(app, B);
    const a = await buy(app, { ...A, ...ip("1.1.1.1") });
    const b = await buy(app, { ...B, ...ip("2.2.2.2") });
    // With one shared ledger the second order would trip the order-splitting rule and need approval.
    expect(a.body.result.outcome).toBe("payment_started");
    expect(b.body.result.outcome).toBe("payment_started");
    expect(payoutCalls).toHaveLength(2);
    expect((await request(app).get("/api/purchases").set(A)).body.purchases).toHaveLength(1);
    expect((await request(app).get("/api/payments").set(B)).body.payments).toHaveLength(1);
    const aPay = a.body.result.payment.paymentId;
    expect((await request(app).get(`/api/payments/${aPay}`).set(B)).status).toBe(404); // B cannot see A's payment
  });

  it("reset wipes one visitor and leaves the other alone", async () => {
    const { app } = build();
    await start(app, A);
    await start(app, B);
    await buy(app, { ...A, ...ip("1.1.1.1") });
    await buy(app, { ...B, ...ip("2.2.2.2") });
    expect((await request(app).post("/api/demo/reset").set(A)).body).toEqual({ ok: true });
    expect((await request(app).get("/api/mandate").set(A)).body.mandate).toBeNull();
    expect((await request(app).get("/api/purchases").set(A)).body.purchases).toEqual([]);
    expect((await request(app).get("/api/purchases").set(B)).body.purchases).toHaveLength(1);
    expect((await request(app).get("/api/mandate").set(B)).body.mandate).not.toBeNull();
  });

  it("requests with no valid session id share the default session", async () => {
    const { app } = build({ demo: false });
    const m = (await request(app).post("/api/mandate/parse").send({ text: "Keep flour stocked, $400/week" })).body.mandate;
    await request(app).put("/api/mandate").send(m);
    expect((await request(app).get("/api/mandate").set({ "x-session-id": "bad id!" })).body.mandate?.mandateId).toBe(m.mandateId);
    expect((await request(app).get("/api/mandate").set(A)).body.mandate).toBeNull();
  });
});

describe("purchase limits", () => {
  it("limits one address, then everyone together, with plain messages and Retry-After", async () => {
    const { app, payoutCalls } = build({ demo: { purchasesPerHour: 3, purchasesPerIpPerHour: 2 } });
    for (const id of ["visitor-1111", "visitor-2222", "visitor-3333", "visitor-4444"]) await start(app, { "x-session-id": id });
    const h = (id: string, addr: string) => ({ "x-session-id": id, ...ip(addr) });

    expect((await buy(app, h("visitor-1111", "10.0.0.1"))).status).toBe(200);
    expect((await buy(app, h("visitor-2222", "10.0.0.1"))).status).toBe(200);
    const mine = await buy(app, h("visitor-3333", "10.0.0.1"));
    expect(mine.status).toBe(429);
    expect(mine.body.error).toMatch(/You have used your 2 demo purchases/);
    expect(Number(mine.headers["retry-after"])).toBeGreaterThan(0);
    expect(mine.body.retryAfterSeconds).toBeGreaterThan(0);

    expect((await buy(app, h("visitor-3333", "10.0.0.2"))).status).toBe(200); // a different address is fine
    const all = await buy(app, h("visitor-4444", "10.0.0.3"));
    expect(all.status).toBe(429);
    expect(all.body.error).toMatch(/limit of 3 purchases per hour across all visitors/);
    expect(all.body.error).toMatch(/README/);
    expect(payoutCalls.length).toBeLessThanOrEqual(3);
  });

  it("shows how many purchases are left", async () => {
    const { app } = build({ demo: { purchasesPerHour: 5, purchasesPerIpPerHour: 2 } });
    await start(app, A);
    await buy(app, { ...A, ...ip("10.1.1.1") });
    expect((await request(app).get("/api/demo").set(ip("10.1.1.1"))).body.remaining.purchases).toBe(1);
    expect((await request(app).get("/api/demo").set(ip("10.9.9.9"))).body.remaining.purchases).toBe(2);
  });

  it("requests that never run do not use up a visitor's purchases", async () => {
    const { app } = build({ demo: { purchasesPerIpPerHour: 1 } });
    const h = { ...A, ...ip("10.2.2.2") };
    expect((await buy(app, h)).status).toBe(409); // no rules yet
    await start(app, A);
    expect((await buy(app, h, { category: "", quantity: 0 })).status).toBe(400); // invalid
    expect((await buy(app, h)).status).toBe(200); // the one allowed purchase is still available
    expect((await buy(app, h)).status).toBe(429);
  });

  it("limits AI rule-reading too, and does not count text that is rejected up front", async () => {
    const { app } = build({ demo: { parsesPerIpPerHour: 2 } });
    const parse = (text: string) => request(app).post("/api/mandate/parse").set(ip("10.3.3.3")).send({ text });
    expect((await parse("hi")).status).toBe(422); // too short: not counted
    expect((await parse("Keep flour stocked, $400/week")).status).toBe(200);
    expect((await parse("Keep flour stocked, $400/week")).status).toBe(200);
    const r = await parse("Keep flour stocked, $400/week");
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/2 demo rule readings/);
  });

  it("has no limits outside demo mode", async () => {
    const { app } = build({ demo: false });
    const m = (await request(app).post("/api/mandate/parse").send({ text: "Keep flour and sheet pans stocked, $400/week" })).body.mandate;
    await request(app).put("/api/mandate").send(m);
    for (let i = 0; i < 6; i++) expect((await buy(app, {})).status).toBe(200);
  });
});

describe("webhooks reach the right visitor", () => {
  it("finds the payment in the session that owns it and updates only that one", async () => {
    const { app, sessions } = build();
    await start(app, A);
    await start(app, B);
    const a = await buy(app, { ...A, ...ip("1.1.1.1") });
    const b = await buy(app, { ...B, ...ip("2.2.2.2") });
    const aBatch = a.body.result.payment.payoutBatchId;

    const hook = await request(app)
      .post("/webhooks/paypal")
      .set("content-type", "application/json")
      .send(JSON.stringify({ id: "WH-X", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_batch_id: aBatch, payout_item_id: "I1" } }));
    expect(hook.body).toMatchObject({ handled: true, status: "SUCCESS" });
    expect(sessions.get("visitor-aaaa").store.get(a.body.result.payment.paymentId)?.status).toBe("SUCCESS");
    expect(sessions.get("visitor-bbbb").store.get(b.body.result.payment.paymentId)?.status).toBe("PROCESSING");
  });
});

describe("a purchase uses the rules the visitor confirmed", () => {
  it("the instant demo rules need no AI call, not even for the purchase", async () => {
    const { app, llmCalls } = build();
    await start(app, A);
    const r = await buy(app, { ...A, ...ip("3.3.3.3") });
    expect(r.body.result.outcome).toBe("payment_started");
    expect(llmCalls.n).toBe(0);
  });

  it("numbers edited on the review screen are the ones enforced", async () => {
    const { app, llmCalls, payoutCalls } = build();
    const parsed = await request(app).post("/api/mandate/parse").set(A).send({ text: "Keep flour and sheet pans stocked, $400/week, auto-approve under $100" });
    expect(llmCalls.n).toBe(1);
    const edited = { ...parsed.body.mandate, autoApproveUnderCents: 7_500 };
    expect((await request(app).put("/api/mandate").set(A).send(edited)).status).toBe(200);

    const r = await buy(app, { ...A, ...ip("4.4.4.4") });
    expect(llmCalls.n).toBe(1); // the purchase did not read the text again
    expect(r.body.result.mandate.autoApproveUnderCents).toBe(7_500);
    expect(r.body.result.outcome).toBe("awaiting_approval");
    expect(payoutCalls).toHaveLength(0);
  });
});
