import { randomUUID } from "node:crypto";
import {
  DealSchema,
  evaluatePolicy,
  type Deal,
  type Mandate,
  type PolicyResult,
  type SpendLedger,
} from "@autopilot/guardrail";
import { PayPalError } from "../paypal/client.js";
import type { PayoutsClient } from "../paypal/payouts.js";
import type { PaymentRecord, PaymentStore } from "./store.js";

export interface PaymentDeps {
  ledger: SpendLedger;
  store: PaymentStore;
  payouts: PayoutsClient;
  now?: () => number;
}

const nowOf = (d: PaymentDeps) => d.now?.() ?? Date.now();

/** A refused action on a payment (unknown id, wrong state, not supported). Maps to an HTTP status. */
export class PaymentActionError extends Error {
  constructor(
    public status: 404 | 409 | 501 | 503,
    message: string,
  ) {
    super(message);
  }
}

function need(deps: PaymentDeps, paymentId: string): PaymentRecord {
  const rec = deps.store.get(paymentId);
  if (!rec) throw new PaymentActionError(404, `Unknown payment ${paymentId}`);
  return rec;
}

function newRecord(
  deps: PaymentDeps,
  dealInput: unknown,
  requestInput: unknown,
  result: PolicyResult,
  status: PaymentRecord["status"],
): PaymentRecord {
  const parsed = DealSchema.safeParse(dealInput);
  const d = parsed.success ? parsed.data : undefined;
  const t = nowOf(deps);
  return deps.store.create({
    paymentId: `pay_${randomUUID()}`,
    dealId: d?.dealId ?? "invalid",
    negotiationId: d?.negotiationId ?? "invalid",
    vendorId: d?.vendorId ?? "invalid",
    payeeEmail: d?.payeeEmail ?? "",
    amountCents: d?.totalCents ?? 0,
    currency: d?.currency ?? "",
    status,
    decision: result.decision,
    summary: result.summary,
    checks: result.checks,
    deal: dealInput,
    request: requestInput,
    events: [{ at: t, type: "policy_evaluated", detail: result.summary }],
    createdAt: t,
    updatedAt: t,
  });
}

/**
 * Money leaves ONLY from here, and ONLY after evaluatePolicy returned "allow".
 * The ledger reservation happens synchronously right after evaluation (no await in between),
 * so two concurrent requests cannot both pass the budget check.
 */
async function execute(deps: PaymentDeps, rec: PaymentRecord, deal: Deal): Promise<PaymentRecord> {
  deps.ledger.add({
    dealId: deal.dealId,
    vendorId: deal.vendorId,
    amountCents: deal.totalCents,
    currency: deal.currency,
    at: nowOf(deps),
  });
  const senderBatchId = `cfo-${deal.dealId}`;
  deps.store.update(rec.paymentId, { status: "PROCESSING", senderBatchId }, { type: "payout_requested" });

  try {
    const out = await deps.payouts.createPayout({
      senderBatchId,
      senderItemId: `item-${deal.dealId}`,
      email: deal.payeeEmail,
      amountCents: deal.totalCents,
      currency: deal.currency,
      note: `Autopilot CFO order ${deal.dealId}`,
    });
    return deps.store.update(
      rec.paymentId,
      { payoutBatchId: out.payoutBatchId },
      { type: "payout_created", detail: out.batchStatus },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof PayPalError && e.status < 500) {
      // Definitive rejection: money did not move. Release the reservation.
      deps.ledger.remove(deal.dealId);
      return deps.store.update(rec.paymentId, { status: "FAILED" }, { type: "payout_rejected", detail: msg });
    }
    // Timeout / 5xx: outcome unknown. Keep the reservation so we never double-spend.
    return deps.store.update(rec.paymentId, { status: "UNKNOWN" }, { type: "payout_unknown", detail: msg });
  }
}

export async function submitPayment(
  deps: PaymentDeps,
  mandate: Mandate,
  dealInput: unknown,
  requestInput?: unknown,
): Promise<PaymentRecord> {
  const parsed = DealSchema.safeParse(dealInput);
  const request =
    requestInput ??
    (parsed.success
      ? {
          dealId: parsed.data.dealId,
          payeeEmail: parsed.data.payeeEmail,
          amountCents: parsed.data.totalCents,
          currency: parsed.data.currency,
        }
      : undefined);

  if (parsed.success) {
    const pending = deps.store.findByDeal(parsed.data.dealId).find((r) => r.status === "PENDING_APPROVAL");
    if (pending) return pending;
  }

  const result = evaluatePolicy({ mandate, deal: dealInput, request, ledger: deps.ledger, now: nowOf(deps) });

  if (result.decision === "deny") return newRecord(deps, dealInput, request, result, "DENIED");
  if (result.decision === "require_approval") {
    return newRecord(deps, dealInput, request, result, "PENDING_APPROVAL");
  }
  const rec = newRecord(deps, dealInput, request, result, "PROCESSING");
  return execute(deps, rec, DealSchema.parse(dealInput));
}

export async function approvePayment(deps: PaymentDeps, mandate: Mandate, paymentId: string) {
    const rec = need(deps, paymentId);
  if (rec.status !== "PENDING_APPROVAL") throw new PaymentActionError(409, `Payment is ${rec.status}, not PENDING_APPROVAL`);

  // Re-evaluate at approval time: budget, quote freshness etc. may have changed.
  const result = evaluatePolicy({
    mandate,
    deal: rec.deal,
    request: rec.request,
    ledger: deps.ledger,
    now: nowOf(deps),
    ownerApproved: true,
  });
  if (result.decision !== "allow") {
    return deps.store.update(
      paymentId,
      { status: "DENIED", decision: result.decision, summary: result.summary, checks: result.checks },
      { type: "approval_denied_on_recheck", detail: result.summary },
    );
  }
  deps.store.update(
    paymentId,
    { decision: "allow", summary: "Approved by owner; all hard limits re-checked and passed.", checks: result.checks },
    { type: "owner_approved" },
  );
  return execute(deps, rec, DealSchema.parse(rec.deal));
}

export function rejectPayment(deps: PaymentDeps, paymentId: string) {
  const rec = need(deps, paymentId);
  if (rec.status !== "PENDING_APPROVAL") throw new PaymentActionError(409, `Payment is ${rec.status}, not PENDING_APPROVAL`);
  return deps.store.update(paymentId, { status: "REJECTED" }, { type: "owner_rejected" });
}

const FAILED_ITEM = new Set(["FAILED", "DENIED", "BLOCKED", "CANCELED"]);
const REVERSED_ITEM = new Set(["RETURNED", "REFUNDED", "REVERSED"]);

/** Asks PayPal where the payout stands and updates our record. Safe to call repeatedly. */
export async function syncPayment(deps: PaymentDeps, paymentId: string): Promise<PaymentRecord> {
  const rec = need(deps, paymentId);
  if (!rec.payoutBatchId || !["PROCESSING", "UNKNOWN", "SUCCESS"].includes(rec.status)) return rec;
  if (!deps.payouts.getBatch) throw new PaymentActionError(501, "Looking up payout status is not supported by this payment provider.");

  const batch = await deps.payouts.getBatch(rec.payoutBatchId);
  const item = batch.items[0];
  if (!item) return rec;

  let status = rec.status;
  if (item.status === "SUCCESS") status = "SUCCESS";
  else if (FAILED_ITEM.has(item.status)) status = "FAILED";
  else if (REVERSED_ITEM.has(item.status)) status = "REVERSED";
  else if (rec.status === "UNKNOWN") status = "PROCESSING"; // PayPal knows this payout, so the request did arrive

  const unchanged = status === rec.status && rec.payoutItemStatus === item.status && rec.payoutItemId === item.payoutItemId && rec.payoutBatchStatus === batch.batchStatus;
  if (unchanged) return rec;
  // Money did not (or no longer) leave: free the budget it was holding.
  if ((status === "FAILED" || status === "REVERSED") && status !== rec.status) deps.ledger.remove(rec.dealId);
  return deps.store.update(
    paymentId,
    { status, payoutItemId: item.payoutItemId, payoutItemStatus: item.status, payoutBatchStatus: batch.batchStatus },
    { type: "synced_with_paypal", detail: `payout item ${item.status}, batch ${batch.batchStatus}` },
    nowOf(deps),
  );
}

/**
 * Cancels a payout PayPal has not delivered because the recipient has not claimed it (for example, the email has
 * no PayPal account). PayPal returns the money. A delivered payout cannot be cancelled.
 */
export async function cancelPayment(deps: PaymentDeps, paymentId: string): Promise<PaymentRecord> {
  if (!deps.payouts.cancelItem) throw new PaymentActionError(501, "Cancelling payouts is not supported by this payment provider.");
  const rec = await syncPayment(deps, paymentId);
  if (!rec.payoutItemId) throw new PaymentActionError(409, "This payment was never sent to PayPal, so there is nothing to cancel.");

  const s = rec.payoutItemStatus;
  if (s !== "UNCLAIMED") {
    const why =
      s === "SUCCESS"
        ? "This payout was already delivered. PayPal cannot reverse a delivered payout. Ask the vendor to send the money back, then record it with Request refund."
        : s === "PENDING" || s === "ONHOLD" || s === "HELD"
          ? "PayPal is still processing this payout. Refresh the status and try again in a moment."
          : `This payout is ${String(s).toLowerCase()}, so it cannot be cancelled.`;
    throw new PaymentActionError(409, why);
  }

    // PayPal refuses a cancel (BATCH_NOT_COMPLETED) until the whole batch is processed, even when the item is already UNCLAIMED.
  if (rec.payoutBatchStatus !== "SUCCESS") {
    const b = rec.payoutBatchStatus;
    throw new PaymentActionError(
      409,
      b === undefined || b === "PENDING" || b === "PROCESSING"
        ? "PayPal is still finishing this payout batch, and it can only be cancelled once the batch is processed. Check the status again in a few seconds."
        : `PayPal's batch is ${b.toLowerCase()}, so this payout cannot be cancelled.`,
    );
  }

    let out: { status: string };
  try {
    out = await deps.payouts.cancelItem(rec.payoutItemId);
  } catch (e) {
    // PayPal's sandbox sometimes answers a cancel with a 500. The cancel may or may not have gone through, so ask PayPal.
    if (!(e instanceof PayPalError) || e.status < 500) throw e;
    const after = await syncPayment(deps, paymentId);
    if (after.status === "REVERSED") return after; // it did go through
    throw new PaymentActionError(503, "PayPal had a temporary error and the payout was not cancelled. Nothing changed; try again in a moment.");
  }
  deps.ledger.remove(rec.dealId);
  return deps.store.update(
    paymentId,
    { status: "REVERSED", payoutItemStatus: out.status },
    { type: "payout_cancelled", detail: "Unclaimed payout cancelled; PayPal returned the money" },
    nowOf(deps),
  );
}

/**
 * Records that the owner asked the vendor for a refund of a DELIVERED payout. This moves no money and
 * PayPal is not involved: a delivered payout cannot be reversed through the API.
 */
export async function requestRefund(deps: PaymentDeps, paymentId: string, reason?: string): Promise<PaymentRecord> {
  let rec = need(deps, paymentId);
  if (rec.status === "PROCESSING" && deps.payouts.getBatch) rec = await syncPayment(deps, paymentId);
  if (rec.status !== "SUCCESS") {
    throw new PaymentActionError(409, "Only a delivered payment can be refunded. Refresh the status first, or cancel it if it is unclaimed.");
  }
  if (rec.refund) throw new PaymentActionError(409, "A refund was already requested for this payment.");
  const text = reason?.trim().slice(0, 300) || undefined;
  return deps.store.update(
    paymentId,
    { refund: { state: "REQUESTED", requestedAt: nowOf(deps), reason: text } },
    { type: "refund_requested", detail: text ?? "no reason given" },
    nowOf(deps),
  );
}

/** The owner confirms the vendor sent the money back. The app cannot verify this; it is the owner's record. */
export async function markRefundReceived(deps: PaymentDeps, paymentId: string): Promise<PaymentRecord> {
  const rec = need(deps, paymentId);
  if (rec.refund?.state !== "REQUESTED") throw new PaymentActionError(409, "No refund is waiting to be confirmed for this payment.");
  deps.ledger.remove(rec.dealId); // the money is back, so it no longer counts against the weekly budget
  return deps.store.update(
    paymentId,
    { status: "REVERSED", refund: { ...rec.refund, state: "RECEIVED", receivedAt: nowOf(deps) } },
    { type: "refund_received", detail: "Owner confirmed the vendor returned the money" },
    nowOf(deps),
  );
}
