import { useState } from "react";
import { ApiError, type Api } from "../api";
import type { PaymentRecord } from "../types";

const errorText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong.");
const day = (t?: number) => (t ? new Date(t).toLocaleString() : "");

/**
 * What the owner can do after a payment was sent. These are honest about PayPal's limits:
 * an UNCLAIMED payout can be cancelled (PayPal returns the money); a DELIVERED payout cannot be reversed,
 * so the app only records a refund request to the vendor.
 */
export function PaymentActions({ payment, api, onUpdated }: { payment: PaymentRecord; api: Api; onUpdated: (p: PaymentRecord) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const sent = Boolean(payment.payoutBatchId);
  if (!sent && payment.status !== "REVERSED") return null;

  async function run(name: string, action: () => Promise<PaymentRecord>) {
    setBusy(name);
    setError(null);
    try {
      onUpdated(await action());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const canCheck = sent && ["PROCESSING", "UNKNOWN", "SUCCESS"].includes(payment.status);
  const unclaimed = payment.status === "PROCESSING" && payment.payoutItemStatus === "UNCLAIMED";
  // PayPal only lets an unclaimed payout be cancelled once the whole batch is processed.
  const cancellable = unclaimed && payment.payoutBatchStatus === "SUCCESS";
  const canRequestRefund = payment.status === "SUCCESS" && !payment.refund;

  return (
    <div className="actions" aria-label="Payment actions">
      {payment.payoutItemStatus && <p className="small muted">PayPal says: {payment.payoutItemStatus.replace(/_/g, " ").toLowerCase()}</p>}

      {unclaimed && (
        <div className="alert warn">
          <strong>The vendor has not claimed this payment.</strong> Their email may not have a PayPal account.{" "}
          {cancellable
            ? "You can cancel it and PayPal returns your money."
            : "PayPal is still finishing this payout batch. Once it is processed you can cancel it and get your money back. Check the status again in a few seconds."}
        </div>
      )}

      {payment.status === "REVERSED" && (
        <div className="alert ok">
          {payment.refund?.state === "RECEIVED"
            ? `Refund received${payment.refund.receivedAt ? ` on ${day(payment.refund.receivedAt)}` : ""}. The money is back and no longer counts against your weekly budget.`
            : "Payout cancelled. The money is back in your account and no longer counts against your weekly budget."}
        </div>
      )}

      {payment.refund?.state === "REQUESTED" && (
        <div className="alert warn">
          <strong>Refund requested from the vendor</strong> on {day(payment.refund.requestedAt)}
          {payment.refund.reason ? ` (“${payment.refund.reason}”)` : ""}. PayPal cannot pull a delivered payment back, so the vendor has to send the money. When it arrives, confirm it here.
        </div>
      )}

      {canRequestRefund && (
        <div>
          <label htmlFor={`reason-${payment.paymentId}`}>Reason for a refund (optional)</label>
          <input id={`reason-${payment.paymentId}`} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong item delivered" />
          <p className="small muted">This records a request to the vendor in your ledger. It does not move money; PayPal cannot reverse a payment once it is delivered.</p>
        </div>
      )}

      <div className="row">
        {canCheck && (
          <button type="button" className="btn" disabled={busy !== null} onClick={() => run("sync", () => api.syncPayment(payment.paymentId))}>
            {busy === "sync" ? "Checking..." : "Check PayPal status"}
          </button>
        )}
        {cancellable && (
          <button type="button" className="btn primary" disabled={busy !== null} onClick={() => run("cancel", () => api.cancelPayment(payment.paymentId))}>
            {busy === "cancel" ? "Cancelling..." : "Cancel payout and return my money"}
          </button>
        )}
        {canRequestRefund && (
          <button type="button" className="btn" disabled={busy !== null} onClick={() => run("refund", () => api.requestRefund(payment.paymentId, reason.trim() || undefined))}>
            {busy === "refund" ? "Saving..." : "Request refund from vendor"}
          </button>
        )}
        {payment.refund?.state === "REQUESTED" && (
          <button type="button" className="btn primary" disabled={busy !== null} onClick={() => run("received", () => api.refundReceived(payment.paymentId))}>
            {busy === "received" ? "Saving..." : "I received the money back"}
          </button>
        )}
      </div>

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}