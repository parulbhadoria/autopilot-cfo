import express, { type NextFunction, type Request, type Response } from "express";
import { MandateSchema, type Mandate, type SpendLedger, type Vendor } from "@autopilot/guardrail";
import { ZodError } from "zod";
import type { Llm } from "./llm/types.js";
import { MandateParseError, parseMandate } from "./mandate/parser.js";
import { approvePayment, rejectPayment, submitPayment } from "./payments/service.js";
import type { PaymentStore } from "./payments/store.js";
import type { PayoutsClient } from "./paypal/payouts.js";
import type { WebhookVerifier } from "./paypal/webhook.js";
import { createWebhookRouter } from "./webhooks/router.js";

export interface AppDeps {
  ledger: SpendLedger;
  store: PaymentStore;
  payouts: PayoutsClient;
  verifyWebhook: WebhookVerifier;
  llm?: Llm;
  adminApiKey?: string;
  hardMaxWeeklyCents?: number;
  mandate?: Mandate;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

export function createApp(deps: AppDeps) {
  const app = express();
  let mandate: Mandate | null = deps.mandate ?? null;
  const payDeps = { ledger: deps.ledger, store: deps.store, payouts: deps.payouts };

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
      const vendors: Vendor[] = Array.isArray(req.body?.vendors) ? req.body.vendors : [];
      const out = await parseMandate(String(req.body?.text ?? ""), {
        llm: deps.llm,
        vendors,
        hardMaxWeeklyCents: deps.hardMaxWeeklyCents ?? 500_000,
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

  app.use("/api", api);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: "validation", issues: err.issues });
    if (err instanceof MandateParseError) return res.status(422).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  });

  return app;
}
