import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { MandateSchema, type Mandate, type SpendLedger, type Vendor } from "@autopilot/guardrail";
import { ZodError, z } from "zod";
import type { MarketLookup } from "./channel3/market.js";
import type { Llm } from "./llm/types.js";
import { MandateParseError, parseMandate } from "./mandate/parser.js";
import { approvePayment, rejectPayment, submitPayment } from "./payments/service.js";
import { runPurchase, type PurchaseDeps } from "./pipeline/purchase.js";
import { PurchaseStore } from "./purchases/store.js";
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

export interface AppDeps {
  ledger: SpendLedger;
  store: PaymentStore;
  payouts: PayoutsClient;
  verifyWebhook: WebhookVerifier;
  llm?: Llm;
  adminApiKey?: string;
  hardMaxWeeklyCents?: number;
  mandate?: Mandate;
  /** Enables POST /api/purchase. */
  purchase?: PurchaseConfig;
  purchases?: PurchaseStore;
  /** Folder with the built web UI (apps/web/dist). When set, the server also serves the UI. */
  staticDir?: string;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

export function createApp(deps: AppDeps) {
  const app = express();
  let mandate: Mandate | null = deps.mandate ?? null;
  const payDeps = { ledger: deps.ledger, store: deps.store, payouts: deps.payouts };
  const purchases = deps.purchases ?? new PurchaseStore();

  // Webhook route comes BEFORE express.json: signature verification needs the raw body.
  app.use("/webhooks/paypal", createWebhookRouter({ store: deps.store, ledger: deps.ledger, verify: deps.verifyWebhook }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, mandateSet: mandate !== null }));

  const api = express.Router();
  api.use((req, res, next) => {
    if (deps.adminApiKey && req.header("x-api-key") !== deps.adminApiKey) {
      return res.status(401).json({ error: "missing or bad x-api-key" });
    }
    next();
  });

  // Step 1: plain English -> DRAFT mandate (not active until the owner confirms with PUT).
  api.post(
    "/mandate/parse",
    wrap(async (req, res) => {
      if (!deps.llm) return res.status(501).json({ error: "LLM not configured" });
      // When purchasing is configured, the vendor and its categories come from the server, not the client.
      const vendors: Vendor[] = Array.isArray(req.body?.vendors)
        ? req.body.vendors
        : deps.purchase
          ? [deps.purchase.seller.vendor]
          : [];
      const out = await parseMandate(String(req.body?.text ?? ""), {
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
      mandate = MandateSchema.parse(req.body);
      res.json({ mandate });
    }),
  );
  api.get("/mandate", (_req, res) => res.json({ mandate }));

  api.post(
    "/pay",
    wrap(async (req, res) => {
      if (!mandate) return res.status(409).json({ error: "No active mandate. PUT /api/mandate first." });
      res.json(await submitPayment(payDeps, mandate, req.body?.deal, req.body?.request));
    }),
  );
  api.get("/payments", (_req, res) => res.json({ payments: deps.store.list() }));
  api.get("/payments/:id", (req, res) => {
    const rec = deps.store.get(req.params.id);
    return rec ? res.json(rec) : res.status(404).json({ error: "not found" });
  });
  api.post(
    "/payments/:id/approve",
    wrap(async (req, res) => {
      if (!mandate) return res.status(409).json({ error: "No active mandate." });
      res.json(await approvePayment(payDeps, mandate, req.params.id));
    }),
  );
  api.post("/payments/:id/reject", (req, res) => res.json(rejectPayment(payDeps, req.params.id)));

  // Shop -> negotiate -> policy gate -> pay, using the owner's active mandate.
  api.post(
    "/purchase",
    wrap(async (req, res) => {
      if (!deps.purchase) return res.status(501).json({ error: "Purchasing is not configured" });
      if (!mandate) return res.status(409).json({ error: "No active mandate. PUT /api/mandate first." });
      const need = PurchaseBodySchema.parse(req.body);
      const result = await runPurchase(
        {
          llm: deps.llm ?? noLlm,
          seller: deps.purchase.seller,
          payments: payDeps,
          makeBuyer: deps.purchase.makeBuyer,
          market: deps.purchase.market,
          hardMaxWeeklyCents: deps.hardMaxWeeklyCents ?? 500_000,
        },
        { ownerText: mandate.ownerNote ?? "", need, parsedMandate: { mandate, assumptions: [] } },
      );
      res.json(purchases.create(need, result));
    }),
  );
  api.get("/purchases", (_req, res) => res.json({ purchases: purchases.list() }));
  api.get("/purchases/:id", (req, res) => {
    const run = purchases.get(req.params.id);
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
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  });

  return app;
}