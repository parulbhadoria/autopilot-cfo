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
  const rec = deps.store.get(paymentId);
  if (!rec) throw new Error(`Unknown payment ${paymentId}`);
  if (rec.status !== "PENDING_APPROVAL") throw new Error(`Payment is ${rec.status}, not PENDING_APPROVAL`);

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
  const rec = deps.store.get(paymentId);
  if (!rec) throw new Error(`Unknown payment ${paymentId}`);
  if (rec.status !== "PENDING_APPROVAL") throw new Error(`Payment is ${rec.status}, not PENDING_APPROVAL`);
  return deps.store.update(paymentId, { status: "REJECTED" }, { type: "owner_rejected" });
}
