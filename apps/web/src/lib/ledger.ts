import type { PurchaseRun, TranscriptEntry } from "../types";
import { effectiveOutcome, outcomeInfo } from "./purchase";

/** Human names for the policy checks, in the order the gate runs them. */
export const CHECK_LABELS: Record<string, string> = {
  schema_valid: "Inputs are well-formed",
  mandate_active: "Mandate is active",
  currency_match: "Currency matches",
  amount_integrity: "Total adds up",
  hidden_fees: "No hidden fees",
  price_drift: "Matches the agreed price",
  quote_fresh: "Quote still valid",
  vendor_allowlisted: "Vendor is allowed",
  payee_matches: "Pays the right account",
  category_allowed: "Item is allowed",
  per_txn_cap: "Within per-purchase cap",
  weekly_budget: "Within weekly budget",
  replay: "Not paid before",
  order_splitting: "No order splitting",
  approval_threshold: "Under auto-approve limit",
};

export const checkLabel = (id: string) => CHECK_LABELS[id] ?? id;

const PAID = new Set(["PROCESSING", "SUCCESS"]);

export interface NegotiationRow {
  runId: string;
  when: number;
  item: string;
  quantity: number;
  outcome: string;
  outcomeText: string;
  tone: "ok" | "warn" | "bad" | "info";
  rounds: number;
  openingCents?: number;
  finalCents?: number;
  /** Opening total minus final total, only counted when the order was actually paid. */
  savedCents?: number;
  marketMedianCents?: number;
  paymentStatus: string;
  /** PayPal's own word for the payout item (success, unclaimed, ...), once we have asked. */
  payoutItemStatus: string;
  /** "requested" or "received" when a refund was asked of the vendor. */
  refundState: string;
  amountCents?: number;
  checksPassed: number;
  checksTotal: number;
  /** What stopped it, in plain words (empty when nothing did). */
  blockedBy: string;
}

function blockedBy(run: PurchaseRun): string {
  const r = run.result;
  const outcome = effectiveOutcome(r);
  if (outcome === "invoice_mismatch") return "Invoice check";
  if (outcome === "category_not_authorized") return "Your mandate";
  if (outcome === "payment_denied") {
    const failed = r.payment?.checks.find((c) => !c.passed && c.id !== "approval_threshold");
    return failed ? checkLabel(failed.id) : "Policy gate";
  }
  if (outcome === "rejected_by_owner") return "You";
  return "";
}

export function toNegotiationRows(runs: PurchaseRun[]): NegotiationRow[] {
  return runs.map((run) => {
    const r = run.result;
    const transcript = r.negotiation?.transcript ?? [];
    const opening = transcript.find((e) => e.type === "open")?.totalCents;
    const accepted = [...transcript].reverse().find((e) => e.from === "seller" && e.type === "accept")?.totalCents;
    const paymentStatus = r.payment?.status ?? "";
    const counted = r.negotiation?.outcome === "deal" && PAID.has(paymentStatus);
    const checks = r.payment?.checks ?? [];
    const outcome = effectiveOutcome(r);
    const info = outcomeInfo(outcome);
    return {
      runId: run.runId,
      when: run.createdAt,
      item: run.request.category,
      quantity: run.request.quantity,
      outcome,
      outcomeText: info.text.split(".")[0],
      tone: info.tone,
      rounds: r.negotiation?.rounds ?? 0,
      openingCents: opening,
      finalCents: accepted,
      savedCents: counted && opening !== undefined && accepted !== undefined ? opening - accepted : undefined,
      marketMedianCents: r.market && r.market.count > 0 ? r.market.medianCents : undefined,
      paymentStatus,
      payoutItemStatus: (r.payment?.payoutItemStatus ?? "").toLowerCase(),
      refundState: (r.payment?.refund?.state ?? "").toLowerCase(),
      amountCents: r.payment?.amountCents,
      checksPassed: checks.filter((c) => c.passed).length,
      checksTotal: checks.length,
      blockedBy: blockedBy(run),
    };
  });
}

export interface EventRow {
  key: string;
  seq: number;
  at: number;
  round: number;
  actor: "Agent" | "Vendor" | "Guardrail";
  action: string;
  unitPriceCents?: number;
  totalCents?: number;
  note: string;
}

const ACTIONS: Record<TranscriptEntry["type"], string> = {
  open: "Opens at",
  offer: "Offers",
  counter: "Counters",
  accept: "Accepts",
  reject: "Rejects invoice",
  walk_away: "Walks away",
  expired: "Quote expired",
};

export function toEventRows(run: PurchaseRun | undefined): EventRow[] {
  const transcript = run?.result.negotiation?.transcript ?? [];
  return transcript.map((e) => ({
    key: `${e.negotiationId}-${e.seq}`,
    seq: e.seq,
    at: e.at,
    round: e.round,
    actor: e.from === "buyer" ? (e.type === "reject" ? "Guardrail" : "Agent") : "Vendor",
    action: ACTIONS[e.type] ?? e.type,
    unitPriceCents: e.unitPriceCents,
    totalCents: e.totalCents,
    note: e.reasoning || e.message || "",
  }));
}

export interface CheckRow {
  id: string;
  label: string;
  passed: boolean;
  /** What happens if the check fails. */
  severity: "Blocks the payment" | "Needs your approval";
  message: string;
}

export function toCheckRows(run: PurchaseRun | undefined): CheckRow[] {
  return (run?.result.payment?.checks ?? []).map((c) => ({
    id: c.id,
    label: checkLabel(c.id),
    passed: c.passed,
    severity: c.onFail === "deny" ? "Blocks the payment" : "Needs your approval",
    message: c.message,
  }));
}

export interface LedgerSummary {
  runs: number;
  paidCents: number;
  /** Orders stopped by a guardrail (denied, bad invoice, or not allowed). */
  blocked: number;
  savedCents: number;
  /** Money that came back to the owner (cancelled or refunded payouts). */
  returnedCents: number;
}

export function summarize(rows: NegotiationRow[]): LedgerSummary {
  return {
    runs: rows.length,
    paidCents: rows.filter((r) => PAID.has(r.paymentStatus)).reduce((a, r) => a + (r.amountCents ?? 0), 0),
    blocked: rows.filter((r) => ["payment_denied", "invoice_mismatch", "category_not_authorized"].includes(r.outcome)).length,
    savedCents: rows.reduce((a, r) => a + (r.savedCents ?? 0), 0),
    returnedCents: rows.filter((r) => r.paymentStatus === "REVERSED").reduce((a, r) => a + (r.amountCents ?? 0), 0),
  };
}