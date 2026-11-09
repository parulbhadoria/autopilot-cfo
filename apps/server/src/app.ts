import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { MandateSchema, type Mandate, type SpendLedger, type Vendor } from "@autopilot/guardrail";
import { ZodError, z } from "zod";
import type { MarketLookup } from "./channel3/market.js";
import type { Llm } from "./llm/types.js";
import { MandateParseError, parseMandate } from "./mandate/parser.js";
import { PayPalError } from "./paypal/client.js";
import { PaymentActionError, approvePayment, cancelPayment, markRefundReceived, rejectPayment, requestRefund, submitPayment, syncPayment, type PaymentDeps } from "./payments/service.js";
import { WindowLimiter, consumeAll, type LimitCheck } from "./limiter.js";
import { DEFAULT_SESSION, SessionManager, isValidSessionId, type Session } from "./sessions.js";
import { runPurchase, type PurchaseDeps } from "./pipeline/purchase.js";
import type { Seller } from "./seller/seller.js";
import type { PaymentStore } from "./payments/store.js";
import type { PayoutsClient } from "./paypal/payouts.js";
import type { WebhookVerifier } from "./paypal/webhook.js";
import { createWebhookRouter } from "./webhooks/router.js";

/** Everything needed to let the API run whole purchases (shop, negotiate, gate, pay). */
export interface PurchaseConfig {
  seller: Seller;
  makeBuyer: PurchaseDeps["makeBuyer"];
  market?: MarketLookup;
}

const PurchaseBodySchema = z.object({
  category: z.string().trim().min(1).max(60),
  quantity: z.number().int().min(1).max(10_000),
  maxUnitPriceCents: z.number().int().positive().max(100_000_000).optional(),
});

const noLlm: Llm = {
  complete: async () => {
    throw new Error("LLM not configured");
  },
};

/** Safeguards for a public demo. Passing this turns demo mode on. A limit of 0 means "no limit". */
export interface DemoConfig {
  /** Purchases per hour across all visitors together. */
  purchasesPerHour: number;
  /** Purchases per hour from one network address. */
  purchasesPerIpPerHour: number;
  /** AI rule-readings per hour, all visitors / one address. */
  parsesPerHour: number;
  parsesPerIpPerHour: number;
}

export const DEFAULT_DEMO_LIMITS: DemoConfig = { purchasesPerHour: 10, purchasesPerIpPerHour: 4, parsesPerHour: 60, parsesPerIpPerHour: 15 };

export const DEMO_NOTE = "Keep flour, butter and sheet pans stocked, max $400/week, auto-approve under $100, ask me for the rest.";

export interface AppDeps {
  /** Per-visitor state. If omitted, one is built from `ledger` and `store` (single-user setups and tests). */
  sessions?: SessionManager;
  ledger?: SpendLedger;
  store?: PaymentStore;
  demo?: DemoConfig;
  /** Clock for the limiters and sessions (tests). */
  now?: () => number;
  payouts: PayoutsClient;
  verifyWebhook: WebhookVerifier;
  llm?: Llm;
  adminApiKey?: string;
  hardMaxWeeklyCents?: number;
  mandate?: Mandate;
  /** Enables POST /api/purchase. */
  purchase?: PurchaseConfig;
  purchases?: import("./purchases/store.js").PurchaseStore;
  /** Folder with the built web UI (apps/web/dist). When set, the server also serves the UI. */
  staticDir?: string;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

export function createApp(deps: AppDeps) {
  const app = express();
  const demo = deps.demo;
  if (demo) app.set("trust proxy", 1); // behind Render's proxy, so req.ip is the visitor, not the proxy

  const sessions =
    deps.sessions ??
    (() => {
      if (!deps.ledger || !deps.store) throw new Error("createApp needs either `sessions`, or `ledger` and `store`.");
      return new SessionManager({ now: deps.now, seed: { ledger: deps.ledger, store: deps.store, purchases: deps.purchases, mandate: deps.mandate ?? null } });
    })();

  const sessionIdOf = (req: Request) => {
    const id = req.header("x-session-id");
    return isValidSessionId(id) ? id : DEFAULT_SESSION;
  };
  const sessionOf = (req: Request): Session => sessions.get(sessionIdOf(req));
  const payDepsOf = (s: Session): PaymentDeps => ({ ledger: s.ledger, store: s.store, payouts: deps.payouts });

  // Public-demo limits (all no-ops when demo mode is off, because their max is 0).
  const hour = 60 * 60_000;
  const limiter = (max: number) => new WindowLimiter({ windowMs: hour, max, now: deps.now });
  const purchasesAll = limiter(demo?.purchasesPerHour ?? 0);
  const purchasesIp = limiter(demo?.purchasesPerIpPerHour ?? 0);
  const parsesAll = limiter(demo?.parsesPerHour ?? 0);
  const parsesIp = limiter(demo?.parsesPerIpPerHour ?? 0);
  const ipOf = (req: Request) => req.ip ?? "unknown";
  const refuse = (res: Response, noun: string, hit: { limiter: WindowLimiter; retryAfterMs: number }) => {
    const secs = Math.max(1, Math.ceil(hit.retryAfterMs / 1000));
    const mins = Math.max(1, Math.ceil(secs / 60));
    const shared = hit.limiter === purchasesAll || hit.limiter === parsesAll;
    const error = shared
      ? `The public demo has reached its limit of ${hit.limiter.max} ${noun} per hour across all visitors. Try again in about ${mins} min, or run the project locally with your own keys (see the README).`
      : `You have used your ${hit.limiter.max} demo ${noun} for this hour. Try again in about ${mins} min.`;
    res.setHeader("Retry-After", String(secs));
    return res.status(429).json({ error, retryAfterSeconds: secs });
  };

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // Webhook route comes BEFORE express.json: signature verification needs the raw body.
  app.use("/webhooks/paypal", createWebhookRouter({ sessions, verify: deps.verifyWebhook }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, mandateSet: sessions.peek(DEFAULT_SESSION)?.mandate != null }));

  const api = express.Router();
  api.use((req, res, next) => {
    if (deps.adminApiKey && req.header("x-api-key") !== deps.adminApiKey) {
      return res.status(401).json({ error: "missing or bad x-api-key" });
    }
    next();
  });

  // What the UI needs to know about the public demo (limits left, whether to show the demo buttons).
  api.get("/demo", (req, res) => {
    if (!demo) return res.json({ demoMode: false });
    const finite = (n: number) => (Number.isFinite(n) ? n : null);
    res.json({
      demoMode: true,
      limits: { purchasesPerHour: demo.purchasesPerHour, purchasesPerVisitorPerHour: demo.purchasesPerIpPerHour },
      remaining: { purchases: finite(Math.min(purchasesAll.remaining(), purchasesIp.remaining(ipOf(req)))) },
    });
  });

  // One click: activate preset rules for this visitor, with no AI call.
  api.post("/demo/start", (req, res) => {
    if (!demo) return res.status(404).json({ error: "Only available in the public demo." });
    if (!deps.purchase) return res.status(501).json({ error: "Purchasing is not configured" });
    const { seller } = deps.purchase;
    const sold = [...new Set(seller.listProducts().map((p) => p.category))];
    const wanted = ["flour", "butter", "sheet pans"].filter((c) => sold.includes(c));
    const mandate = MandateSchema.parse({
      mandateId: `demo_${randomUUID()}`,
      ownerNote: DEMO_NOTE,
      currency: "USD",
      weeklyBudgetCents: 40_000,
      perTransactionCapCents: 40_000,
      autoApproveUnderCents: 10_000,
      categories: wanted.length > 0 ? wanted : sold,
      vendors: [seller.vendor],
    });
    sessionOf(req).mandate = mandate;
    res.json({ mandate, assumptions: ["Demo rules: weekly budget $400, auto-approve under $100."] });
  });

  // Wipe this visitor's rules, budget and history so they can start over.
  api.post("/demo/reset", (req, res) => {
    if (!demo) return res.status(404).json({ error: "Only available in the public demo." });
    sessions.reset(sessionIdOf(req));
    res.json({ ok: true });
  });

  // Step 1: plain English -> DRAFT mandate (not active until the owner confirms with PUT).
  api.post(
    "/mandate/parse",
    wrap(async (req, res) => {
      if (!deps.llm) return res.status(501).json({ error: "LLM not configured" });
      const text = String(req.body?.text ?? "");
      if (text.trim().length < 5 || text.trim().length > 1000) throw new MandateParseError("Instruction must be between 5 and 1000 characters.");
      const gate = consumeAll([
        { limiter: parsesIp, key: ipOf(req) },
        { limiter: parsesAll, key: "" },
      ]);
      if (!gate.ok) return refuse(res, "rule readings", gate);
      // When purchasing is configured, the vendor and its categories come from the server, not the client.
      const vendors: Vendor[] = Array.isArray(req.body?.vendors)
        ? req.body.vendors
        : deps.purchase
          ? [deps.purchase.seller.vendor]
          : [];
      const out = await parseMandate(text, {
        llm: deps.llm,
        vendors,
        hardMaxWeeklyCents: deps.hardMaxWeeklyCents ?? 500_000,
        knownCategories: deps.purchase ? [...new Set(deps.purchase.seller.listProducts().map((p) => p.category))] : undefined,
      });
      res.json(out);
    }),
  );

  // Step 2: owner confirms the (possibly edited) mandate JSON.
  api.put(
    "/mandate",
    wrap((req, res) => {
      const mandate = MandateSchema.parse(req.body);
      sessionOf(req).mandate = mandate;
      res.json({ mandate });
    }),
  );
  api.get("/mandate", (req, res) => res.json({ mandate: sessionOf(req).mandate }));

  api.post(
    "/pay",
    wrap(async (req, res) => {
      // A developer endpoint that accepts any deal. The public demo only pays deals that come out of a negotiation.
      if (demo) return res.status(404).json({ error: "Not available in the public demo." });
      const s = sessionOf(req);
      if (!s.mandate) return res.status(409).json({ error: "No active mandate. PUT /api/mandate first." });
      res.json(await submitPayment(payDepsOf(s), s.mandate, req.body?.deal, req.body?.request));
    }),
  );
  api.get("/payments", (req, res) => res.json({ payments: sessionOf(req).store.list() }));
  api.get("/payments/:id", (req, res) => {
    const rec = sessionOf(req).store.get(req.params.id);
    return rec ? res.json(rec) : res.status(404).json({ error: "not found" });
  });
  api.post(
    "/payments/:id/approve",
    wrap(async (req, res) => {
      const s = sessionOf(req);
      if (!s.mandate) return res.status(409).json({ error: "No active mandate." });
      res.json(await approvePayment(payDepsOf(s), s.mandate, req.params.id));
    }),
  );
  api.post("/payments/:id/reject", (req, res) => res.json(rejectPayment(payDepsOf(sessionOf(req)), req.params.id)));

  // Ask PayPal where a payout stands.
  api.post("/payments/:id/sync", wrap(async (req, res) => res.json(await syncPayment(payDepsOf(sessionOf(req)), req.params.id))));
  // Cancel a payout the recipient has not claimed; PayPal returns the money.
  api.post("/payments/:id/cancel", wrap(async (req, res) => res.json(await cancelPayment(payDepsOf(sessionOf(req)), req.params.id))));
  // Record a refund request to the vendor for a delivered payout (moves no money), then confirm it later.
  api.post(
    "/payments/:id/refund-request",
    wrap(async (req, res) => res.json(await requestRefund(payDepsOf(sessionOf(req)), req.params.id, typeof req.body?.reason === "string" ? req.body.reason : undefined))),
  );
  api.post("/payments/:id/refund-received", wrap(async (req, res) => res.json(await markRefundReceived(payDepsOf(sessionOf(req)), req.params.id))));

  // Shop -> negotiate -> policy gate -> pay, using the owner's active mandate.
  api.post(
    "/purchase",
    wrap(async (req, res) => {
      if (!deps.purchase) return res.status(501).json({ error: "Purchasing is not configured" });
      const s = sessionOf(req);
      if (!s.mandate) return res.status(409).json({ error: "No active mandate. PUT /api/mandate first." });
      const need = PurchaseBodySchema.parse(req.body);
      // Only a purchase that is really going to run counts against the hourly limits.
      const gate = consumeAll([
        { limiter: purchasesIp, key: ipOf(req) },
        { limiter: purchasesAll, key: "" },
      ] satisfies LimitCheck[]);
      if (!gate.ok) return refuse(res, "purchases", gate);
      const result = await runPurchase(
        {
          llm: deps.llm ?? noLlm,
          seller: deps.purchase.seller,
          payments: payDepsOf(s),
          makeBuyer: deps.purchase.makeBuyer,
          market: deps.purchase.market,
          hardMaxWeeklyCents: deps.hardMaxWeeklyCents ?? 500_000,
        },
        { ownerText: s.mandate.ownerNote ?? "", need, parsedMandate: { mandate: s.mandate, assumptions: [] } },
      );
      res.json(s.purchases.create(need, result));
    }),
  );
  api.get("/purchases", (req, res) => res.json({ purchases: sessionOf(req).purchases.list() }));
  api.get("/purchases/:id", (req, res) => {
    const run = sessionOf(req).purchases.get(req.params.id);
    return run ? res.json(run) : res.status(404).json({ error: "not found" });
  });

  app.use("/api", api);
  
  if (deps.staticDir) {
    const dir = resolve(deps.staticDir);
    app.use(express.static(dir));
    // Single-page app: any other GET (not API, webhooks or health) gets index.html.
    app.get(/^\/(?!api\/|webhooks\/|health$).*/, (_req, res) => res.sendFile(resolve(dir, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: "validation", issues: err.issues });
    if (err instanceof MandateParseError) return res.status(422).json({ error: err.message });
    if (err instanceof PaymentActionError) return res.status(err.status).json({ error: err.message });
    if (err instanceof PayPalError) return res.status(502).json({ error: `PayPal said: ${(err.body as any)?.message ?? err.message}` });
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  });

  return app;
}