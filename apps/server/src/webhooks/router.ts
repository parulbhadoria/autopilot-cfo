import express from "express";
import type { SpendLedger } from "@autopilot/guardrail";
import type { PaymentRecord, PaymentStatus, PaymentStore } from "../payments/store.js";
import { BATCH_STATUS_BY_EVENT, ITEM_STATUS_BY_EVENT } from "../paypal/webhookEvents.js";
import type { WebhookVerifier } from "../paypal/webhook.js";

export interface WebhookDeps {
  store: PaymentStore;
  ledger: SpendLedger;
  verify: WebhookVerifier;
}

const FAILED = new Set([
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.DENIED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.CANCELED",
  "PAYMENT.PAYOUTSBATCH.DENIED",
]);
const REVERSED = new Set(["PAYMENT.PAYOUTS-ITEM.RETURNED", "PAYMENT.PAYOUTS-ITEM.REFUNDED"]);

const batchIdOf = (r: any): string | undefined => r?.batch_header?.payout_batch_id ?? r?.payout_batch_id;
const senderBatchIdOf = (r: any): string | undefined =>
  r?.batch_header?.sender_batch_header?.sender_batch_id ?? r?.sender_batch_id;

export function createWebhookRouter(deps: WebhookDeps) {
  const router = express.Router();
  const seen = new Set<string>(); // event-id dedupe (PayPal retries)

  router.post("/", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";

    let ok = false;
    try {
      ok = await deps.verify(req.headers, raw);
    } catch (e) {
      console.error("webhook verification error:", (e as Error).message);
      return res.status(500).json({ error: "verification unavailable" });
    }
    if (!ok) return res.status(401).json({ error: "invalid signature" });

    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "bad json" });
    }

    const type: string = event.event_type ?? "";
    if (event.id && seen.has(event.id)) return res.json({ handled: false, reason: "duplicate" });
    if (!type.startsWith("PAYMENT.PAYOUTS")) return res.json({ handled: false, reason: "ignored event type" });

    const resource = event.resource;
    const b = batchIdOf(resource);
    const s = senderBatchIdOf(resource);
    const rec = (b && deps.store.findByBatch(b)) || (s && deps.store.findByBatch(s)) || undefined;
    // 404 on purpose: PayPal retries, which covers the race where the webhook beats our own write.
    if (!rec) return res.status(404).json({ handled: false, reason: "unknown payout" });

    // Only an ITEM event decides what happened to the money. A batch can be SUCCESS (processed) while its item
    // is still UNCLAIMED, so batch events update the batch status only.
    let status: PaymentStatus | undefined;
    if (type === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED") status = "SUCCESS";
    else if (FAILED.has(type)) status = "FAILED";
    else if (REVERSED.has(type)) status = "REVERSED";
    // A late "delivered" event must not undo a payment we already know failed or came back.
    if (status === "SUCCESS" && (rec.status === "REVERSED" || rec.status === "FAILED")) status = undefined;

    const patch: Partial<PaymentRecord> = {};
    if (status) patch.status = status;
    const itemStatus = ITEM_STATUS_BY_EVENT[type];
    if (itemStatus) {
      patch.payoutItemStatus = itemStatus;
      if (resource?.payout_item_id) patch.payoutItemId = String(resource.payout_item_id);
    }
    const batchStatus = BATCH_STATUS_BY_EVENT[type];
    if (batchStatus) patch.payoutBatchStatus = batchStatus;

    const detail = resource?.errors?.message ?? resource?.transaction_status ?? undefined;
    deps.store.update(rec.paymentId, patch, { type: `webhook:${type}`, detail });

    // Money did not (or no longer) leave: release the budget reservation.
    if (status === "FAILED" || status === "REVERSED") deps.ledger.remove(rec.dealId);

    if (event.id) seen.add(event.id);
    return res.json({ handled: true, status: status ?? rec.status });
  });

  return router;
}
