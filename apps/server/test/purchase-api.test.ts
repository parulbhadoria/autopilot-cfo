import request from "supertest";
import { describe, expect, it } from "vitest";
import { InMemoryLedger } from "@autopilot/guardrail";
import { createApp } from "../src/app.js";
import { createRuleBuyer } from "../src/negotiation/index.js";
import { PaymentStore } from "../src/payments/store.js";
import type { CreatePayoutArgs, PayoutsClient } from "../src/paypal/payouts.js";
import { MaliciousSeller, Seller, type Attack } from "../src/seller/index.js";

const vendor = { vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: "vendor@example.com" };
const OWNER = "Keep flour and sheet pans stocked, max $400/week, auto-approve under $100.";

function build(opts: { attacks?: Attack[]; configured?: boolean; adminApiKey?: string } = {}) {
  const payoutCalls: CreatePayoutArgs[] = [];
  const payouts: PayoutsClient = { createPayout: async (a) => (payoutCalls.push(a), { payoutBatchId: `B-${a.senderBatchId}`, batchStatus: "PENDING" }) };
  const seller = opts.attacks ? new MaliciousSeller({ vendor, attacks: opts.attacks }) : new Seller({ vendor });
  const app = createApp({
    ledger: new InMemoryLedger(),
    store: new PaymentStore(),
    payouts,
    verifyWebhook: async () => true,
    llm: { complete: async () => JSON.stringify({ weeklyBudget: 400, autoApproveUnder: 100, categories: ["flour", "sheet pans", "gold"] }) },
    adminApiKey: opts.adminApiKey,
    purchase: opts.configured === false ? undefined : { seller, makeBuyer: (a) => createRuleBuyer({ maxUnitPriceCents: a.maxUnitPriceCents }) },
  });
  return { app, payoutCalls };
}

async function activate(app: any, headers: Record<string, string> = {}) {
  const parsed = await request(app).post("/api/mandate/parse").set(headers).send({ text: OWNER });
  expect(parsed.status).toBe(200);
  const put = await request(app).put("/api/mandate").set(headers).send(parsed.body.mandate);
  expect(put.status).toBe(200);
  return parsed.body;
}
const buy = (app: any, body: unknown, headers: Record<string, string> = {}) => request(app).post("/api/purchase").set(headers).send(body as object);

describe("mandate parsing through the API", () => {
  it("uses the server's vendor and restricts categories to what the vendor sells", async () => {
    const { app } = build();
    const body = await activate(app);
    expect(body.mandate.vendors).toEqual([vendor]);
    expect(body.mandate.categories).toEqual(["flour", "sheet pans"]);
    expect(body.assumptions.some((a: string) => /Ignored "gold"/.test(a))).toBe(true);
  });
});

describe("POST /api/purchase", () => {
  it("501 when purchasing is not configured; 409 without an active mandate", async () => {
    expect((await buy(build({ configured: false }).app, { category: "sheet pans", quantity: 4 })).status).toBe(501);
    expect((await buy(build().app, { category: "sheet pans", quantity: 4 })).status).toBe(409);
  });

  it("400 on invalid bodies", async () => {
    const { app } = build();
    await activate(app);
    for (const bad of [{}, { category: "", quantity: 4 }, { category: "sheet pans", quantity: 0 }, { category: "sheet pans", quantity: 1.5 }, { category: "sheet pans", quantity: 4, maxUnitPriceCents: -1 }]) {
      expect((await buy(app, bad)).status).toBe(400);
    }
  });

  it("runs the whole flow and starts a payout for a normal order", async () => {
    const { app, payoutCalls } = build();
    await activate(app);
    const res = await buy(app, { category: "sheet pans", quantity: 4 });
    expect(res.status).toBe(200);
    expect(res.body.runId).toMatch(/^run_/);
    expect(res.body.result.outcome).toBe("payment_started");
    expect(res.body.result.negotiation.transcript.length).toBeGreaterThan(3);
    expect(payoutCalls).toHaveLength(1);

    const pays = await request(app).get("/api/payments");
    expect(pays.body.payments).toHaveLength(1);
    expect(pays.body.payments[0].status).toBe("PROCESSING");
  });

  it("holds a large order for approval; approving it sends the payout", async () => {
    const { app, payoutCalls } = build();
    await activate(app);
    const res = await buy(app, { category: "sheet pans", quantity: 12 });
    expect(res.body.result.outcome).toBe("awaiting_approval");
    expect(payoutCalls).toHaveLength(0);
    const paymentId = res.body.result.payment.paymentId;
    const approved = await request(app).post(`/api/payments/${paymentId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("PROCESSING");
    expect(payoutCalls).toHaveLength(1);
  });

  it("does not let an item outside the mandate through", async () => {
    const { app, payoutCalls } = build();
    await activate(app);
    const res = await buy(app, { category: "butter", quantity: 2 });
    expect(res.body.result.outcome).toBe("category_not_authorized");
    expect(payoutCalls).toHaveLength(0);
  });

  it.each([
    ["payee_swap", "payment_denied"],
    ["price_bump", "invoice_mismatch"],
  ] as [Attack, string][])("a vendor attempting %s is stopped (%s) and no money moves", async (attack, outcome) => {
    const { app, payoutCalls } = build({ attacks: [attack] });
    await activate(app);
    const res = await buy(app, { category: "sheet pans", quantity: 4 });
    expect(res.body.result.outcome).toBe(outcome);
    expect(payoutCalls).toHaveLength(0);
  });
});

describe("purchase history", () => {
  it("lists runs newest first and fetches one by id", async () => {
    const { app } = build();
    await activate(app);
    const a = await buy(app, { category: "sheet pans", quantity: 4 });
    const b = await buy(app, { category: "sheet pans", quantity: 12 });
    const list = await request(app).get("/api/purchases");
    expect(list.body.purchases.map((r: any) => r.runId)).toEqual([b.body.runId, a.body.runId]);
    const one = await request(app).get(`/api/purchases/${a.body.runId}`);
    expect(one.status).toBe(200);
    expect(one.body.request).toEqual({ category: "sheet pans", quantity: 4 });
    expect((await request(app).get("/api/purchases/run_nope")).status).toBe(404);
  });
});

describe("auth", () => {
  it("requires x-api-key for purchase endpoints when configured", async () => {
    const { app } = build({ adminApiKey: "secret" });
    expect((await request(app).post("/api/purchase").send({ category: "sheet pans", quantity: 4 })).status).toBe(401);
    expect((await request(app).get("/api/purchases")).status).toBe(401);
    await activate(app, { "x-api-key": "secret" });
    expect((await buy(app, { category: "sheet pans", quantity: 4 }, { "x-api-key": "secret" })).status).toBe(200);
  });
});

describe("serving the web UI", () => {
  it("serves index.html and static files, keeps /api and /health working, and falls back to index.html for app routes", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "web-"));
    writeFileSync(join(dir, "index.html"), "<html><body>APP SHELL</body></html>");
    writeFileSync(join(dir, "hello.txt"), "static file");

    const app = createApp({
      ledger: new InMemoryLedger(),
      store: new PaymentStore(),
      payouts: { createPayout: async () => ({ payoutBatchId: "B", batchStatus: "PENDING" }) },
      verifyWebhook: async () => true,
      staticDir: dir,
    });
    expect((await request(app).get("/")).text).toContain("APP SHELL");
    expect((await request(app).get("/hello.txt")).text).toBe("static file");
    expect((await request(app).get("/some/client/route")).text).toContain("APP SHELL");
    expect((await request(app).get("/health")).body).toEqual({ ok: true, mandateSet: false });
    expect((await request(app).get("/api/mandate")).body).toEqual({ mandate: null });
    expect((await request(app).get("/api/does-not-exist")).text).not.toContain("APP SHELL");
  });

  it("does not serve anything extra when no UI is configured", async () => {
    const app = createApp({
      ledger: new InMemoryLedger(),
      store: new PaymentStore(),
      payouts: { createPayout: async () => ({ payoutBatchId: "B", batchStatus: "PENDING" }) },
      verifyWebhook: async () => true,
    });
    expect((await request(app).get("/")).status).toBe(404);
  });
});