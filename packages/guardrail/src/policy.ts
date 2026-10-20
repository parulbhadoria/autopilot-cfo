import { DealSchema, MandateSchema, PaymentRequestSchema } from "./schema.js";
import { HOUR_MS, WEEK_MS, sumSpend, type SpendLedger } from "./ledger.js";

export type Decision = "deny" | "require_approval" | "allow";

export interface CheckResult {
  id: string;
  passed: boolean;
  /** What happens if this check fails. */
  onFail: "deny" | "require_approval";
  message: string;
}

export interface PolicyInput {
  mandate: unknown;
  deal: unknown;
  request: unknown;
  ledger: SpendLedger;
  /** Epoch ms. Defaults to Date.now(). */
  now?: number;
  /**
   * Set ONLY by trusted server code after the human owner clicked approve.
   * Waives the approval threshold. Never waives a hard deny (caps, payee, etc.).
   */
  ownerApproved?: boolean;
}

export interface PolicyResult {
  decision: Decision;
  checks: CheckResult[];
  failed: CheckResult[];
  summary: string;
}

const money = (c: number) => (c / 100).toFixed(2);

function check(
  id: string,
  passed: boolean,
  onFail: CheckResult["onFail"],
  okMsg: string,
  failMsg: string,
): CheckResult {
  return { id, passed, onFail, message: passed ? okMsg : failMsg };
}

function finish(checks: CheckResult[]): PolicyResult {
  const failed = checks.filter((c) => !c.passed);
  const denied = failed.filter((c) => c.onFail === "deny");
  const needsApproval = failed.filter((c) => c.onFail === "require_approval");
  const decision: Decision = denied.length ? "deny" : needsApproval.length ? "require_approval" : "allow";
  const summary =
    decision === "allow"
      ? "All policy checks passed."
      : `${decision === "deny" ? "Denied" : "Needs owner approval"}: ${failed.map((c) => c.id).join(", ")}`;
  return { decision, checks, failed, summary };
}

/**
 * Pure, deterministic policy gate. Fails closed: anything malformed is denied.
 * Runs every check (no short-circuit) so the audit ledger shows the full picture.
 * The `notes` field of a deal and any agent "reasoning" are never inspected.
 */
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const now = input.now ?? Date.now();
  const m = MandateSchema.safeParse(input.mandate);
  const d = DealSchema.safeParse(input.deal);
  const r = PaymentRequestSchema.safeParse(input.request);

  if (!m.success || !d.success || !r.success) {
    const issues = [
      ...(m.success ? [] : m.error.issues.map((i) => `mandate.${i.path.join(".")}: ${i.message}`)),
      ...(d.success ? [] : d.error.issues.map((i) => `deal.${i.path.join(".")}: ${i.message}`)),
      ...(r.success ? [] : r.error.issues.map((i) => `request.${i.path.join(".")}: ${i.message}`)),
    ];
    return finish([check("schema_valid", false, "deny", "", `Malformed input: ${issues.join("; ")}`)]);
  }

  const mandate = m.data;
  const deal = d.data;
  const req = r.data;
  const ledger = input.ledger;
  const owner = input.ownerApproved === true;

  const vendor = mandate.vendors.find((v) => v.vendorId === deal.vendorId);
  const subtotal = deal.quantity * deal.unitPriceCents;
  const extras = deal.shippingCents + deal.otherFeesCents;
  const expectedTotal = subtotal + extras;
  const spentWeek = sumSpend(ledger, now - WEEK_MS);
  const spentVendorWindow = sumSpend(ledger, now - mandate.splitWindowHours * HOUR_MS, deal.vendorId);
  const cumulativeVendor = spentVendorWindow + deal.totalCents;
  const auto = mandate.autoApproveUnderCents;

  const checks: CheckResult[] = [
    check("schema_valid", true, "deny", "Inputs are well-formed.", ""),
    check(
      "mandate_active",
      mandate.expiresAt === undefined || now < mandate.expiresAt,
      "deny",
      "Mandate is active.",
      "Mandate has expired.",
    ),
    check(
      "currency_match",
      deal.currency === mandate.currency && req.currency === mandate.currency,
      "deny",
      `Currency is ${mandate.currency}.`,
      `Currency mismatch: mandate ${mandate.currency}, deal ${deal.currency}, request ${req.currency}.`,
    ),
    check(
      "amount_integrity",
      Number.isSafeInteger(expectedTotal) && deal.totalCents === expectedTotal,
      "deny",
      "Deal total equals quantity x unit price + shipping + fees.",
      `Deal total ${money(deal.totalCents)} does not equal its components ${money(expectedTotal)}.`,
    ),
    check(
      "hidden_fees",
      extras * 100 <= subtotal * mandate.maxExtraChargesPct,
      "deny",
      `Shipping + fees ${money(extras)} within ${mandate.maxExtraChargesPct}% of subtotal.`,
      `Shipping + fees ${money(extras)} exceed ${mandate.maxExtraChargesPct}% of subtotal ${money(subtotal)}.`,
    ),
    check(
      "price_drift",
      req.dealId === deal.dealId && req.amountCents === deal.totalCents,
      "deny",
      "Payment request matches the agreed deal.",
      `Payment request ${money(req.amountCents)} (deal ${req.dealId}) differs from agreed ${money(deal.totalCents)} (deal ${deal.dealId}).`,
    ),
    check(
      "quote_fresh",
      now <= deal.expiresAt,
      "deny",
      "Quote has not expired.",
      "Quote has expired.",
    ),
    check(
      "vendor_allowlisted",
      vendor !== undefined,
      "deny",
      `Vendor ${vendor?.name} is allowlisted.`,
      `Vendor ${deal.vendorId} is not on the allowlist.`,
    ),
    check(
      "payee_matches",
      vendor !== undefined && deal.payeeEmail === vendor.payeeEmail && req.payeeEmail === vendor.payeeEmail,
      "deny",
      "Payee matches the allowlisted vendor account.",
      "Payee does not match the allowlisted vendor account.",
    ),
    check(
      "category_allowed",
      mandate.categories.some((c) => c.toLowerCase() === deal.category.toLowerCase()),
      "deny",
      `Category "${deal.category}" is allowed.`,
      `Category "${deal.category}" is not in the mandate.`,
    ),
    check(
      "per_txn_cap",
      deal.totalCents <= mandate.perTransactionCapCents,
      "deny",
      "Within per-transaction cap.",
      `Total ${money(deal.totalCents)} exceeds the per-transaction cap ${money(mandate.perTransactionCapCents)}.`,
    ),
    check(
      "weekly_budget",
      spentWeek + deal.totalCents <= mandate.weeklyBudgetCents,
      "deny",
      "Within weekly budget.",
      `Spent ${money(spentWeek)} this week; adding ${money(deal.totalCents)} exceeds ${money(mandate.weeklyBudgetCents)}.`,
    ),
    check(
      "replay",
      !ledger.has(deal.dealId),
      "deny",
      "Deal has not been paid before.",
      `Deal ${deal.dealId} was already paid or reserved (replay).`,
    ),
    check(
      "order_splitting",
      cumulativeVendor <= mandate.perTransactionCapCents,
      "deny",
      "Vendor spend in the split window is within the cap.",
      `Spend to this vendor in ${mandate.splitWindowHours}h would reach ${money(cumulativeVendor)}, above the cap (possible order splitting).`,
    ),
    check(
      "approval_threshold",
      (deal.totalCents < auto && cumulativeVendor < auto) || owner,
      "require_approval",
      owner ? "Owner approved; threshold waived." : `Below auto-approve threshold ${money(auto)}.`,
      `Total ${money(deal.totalCents)} (vendor window ${money(cumulativeVendor)}) is not below the auto-approve threshold ${money(auto)}.`,
    ),
  ];

  return finish(checks);
}
