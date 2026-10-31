import type { PurchaseResult, TranscriptEntry } from "../types";

/** Plain-English label for each negotiation step, so the owner doesn't need to read protocol terms. */
export function describeStep(e: TranscriptEntry): string {
  const who = e.from === "buyer" ? "Your agent" : "Vendor";
  switch (e.type) {
    case "open":
      return "Vendor opens with its price";
    case "offer":
      return `${who} offers ${priceLabel(e)}`;
    case "counter":
      return `${who} counters at ${priceLabel(e)}`;
    case "accept":
      return e.from === "buyer" ? `${who} accepts ${priceLabel(e)}` : `Vendor accepts at ${priceLabel(e)}`;
    case "reject":
      return "Invoice did not match the agreed terms";
    case "walk_away":
      return e.from === "buyer" ? "Your agent walks away" : "Vendor walks away";
    case "expired":
      return "Vendor's price expired";
    default:
      return e.type;
  }
}

function priceLabel(e: TranscriptEntry): string {
  return e.unitPriceCents === undefined ? "" : `${(e.unitPriceCents / 100).toFixed(2)} per unit`;
}

/** Human outcome text for a purchase run. */
export const OUTCOME_TEXT: Record<string, { tone: "ok" | "warn" | "bad" | "info"; text: string }> = {
  payment_started: { tone: "ok", text: "Paid automatically. The payout is on its way." },
  awaiting_approval: { tone: "warn", text: "This order is above your auto-approve limit. Approve it below to pay." },
  payment_denied: { tone: "bad", text: "Blocked by your rules. No money moved." },
  payment_failed: { tone: "bad", text: "The payment could not be sent. No money moved." },
  rejected_by_owner: { tone: "info", text: "You rejected this order. No money moved." },
  payment_reversed: { tone: "info", text: "This payment was cancelled or refunded. The money is back with you." },
  payment_unknown: { tone: "warn", text: "PayPal has not confirmed this payment yet. Check its status." },
  invoice_mismatch: { tone: "bad", text: "The vendor's invoice did not match what was agreed. Nothing was paid." },
  no_deal: { tone: "info", text: "No deal. The agent could not agree a price within its limit." },
  category_not_authorized: { tone: "bad", text: "Your rules do not allow buying this item." },
  no_product: { tone: "bad", text: "This vendor does not sell that item." },
  mandate_error: { tone: "bad", text: "Could not read your rules. Check the mandate." },
};

export function outcomeInfo(outcome: string) {
  return OUTCOME_TEXT[outcome] ?? { tone: "info" as const, text: outcome };
}

/**
 * What actually happened to this order, from the payment's current status. The server stores the outcome as it
 * was when the order was placed, but the payment can change afterwards (approved, cancelled, refunded).
 */
export function effectiveOutcome(r: PurchaseResult): string {
  const status = r.payment?.status;
  switch (status) {
    case undefined:
      return r.outcome;
    case "PENDING_APPROVAL":
      return "awaiting_approval";
    case "REJECTED":
      return "rejected_by_owner";
    case "DENIED":
      return "payment_denied";
    case "FAILED":
      return "payment_failed";
    case "REVERSED":
      return "payment_reversed";
    case "UNKNOWN":
      return "payment_unknown";
    default:
      return "payment_started"; // PROCESSING, SUCCESS
  }
}

const EVENT_LABELS: Record<string, string> = {
  policy_evaluated: "Your rules were checked",
  payout_requested: "Payout sent to PayPal",
  payout_created: "PayPal accepted the payout",
  payout_rejected: "PayPal refused the payout",
  payout_unknown: "PayPal did not answer, so the outcome is unknown",
  synced_with_paypal: "Checked with PayPal",
  owner_approved: "You approved the payment",
  owner_rejected: "You rejected the payment",
  approval_denied_on_recheck: "Approval refused when your rules were re-checked",
  payout_cancelled: "Unclaimed payout cancelled, money returned",
  refund_requested: "Refund requested from the vendor",
  refund_received: "You confirmed the refund arrived",
  "webhook:PAYMENT.PAYOUTSBATCH.PROCESSING": "PayPal is processing the batch",
  "webhook:PAYMENT.PAYOUTSBATCH.SUCCESS": "PayPal finished processing the batch",
  "webhook:PAYMENT.PAYOUTSBATCH.DENIED": "PayPal denied the batch",
  "webhook:PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "PayPal confirmed the payment was delivered",
  "webhook:PAYMENT.PAYOUTS-ITEM.UNCLAIMED": "PayPal says the vendor has not claimed the payment",
  "webhook:PAYMENT.PAYOUTS-ITEM.HELD": "PayPal is holding the payment",
  "webhook:PAYMENT.PAYOUTS-ITEM.FAILED": "PayPal says the payment failed",
  "webhook:PAYMENT.PAYOUTS-ITEM.DENIED": "PayPal says the payment was denied",
  "webhook:PAYMENT.PAYOUTS-ITEM.BLOCKED": "PayPal says the payment was blocked",
  "webhook:PAYMENT.PAYOUTS-ITEM.CANCELED": "PayPal says the payment was cancelled",
  "webhook:PAYMENT.PAYOUTS-ITEM.RETURNED": "PayPal returned the money to you",
  "webhook:PAYMENT.PAYOUTS-ITEM.REFUNDED": "PayPal refunded the money to you",
};

/** A payment-history event in plain English. `viaWebhook` marks updates PayPal pushed to us. */
export function describeEvent(e: { type: string; detail?: string }): { label: string; detail?: string; viaWebhook: boolean } {
  const viaWebhook = e.type.startsWith("webhook:");
  const label = EVENT_LABELS[e.type] ?? (viaWebhook ? `PayPal event: ${e.type.slice("webhook:".length)}` : e.type);
  return { label, detail: e.detail, viaWebhook };
}