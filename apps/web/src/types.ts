// Shapes returned by the Autopilot CFO API. Money is always integer cents.
export interface Vendor {
  vendorId: string;
  name: string;
  payeeEmail: string;
}

export interface Mandate {
  mandateId: string;
  ownerNote?: string;
  currency: string;
  weeklyBudgetCents: number;
  perTransactionCapCents: number;
  autoApproveUnderCents: number;
  categories: string[];
  vendors: Vendor[];
  maxExtraChargesPct: number;
  splitWindowHours: number;
  expiresAt?: number;
}

export interface ParsedMandate {
  mandate: Mandate;
  assumptions: string[];
}

export interface CheckResult {
  id: string;
  passed: boolean;
  onFail: "deny" | "require_approval";
  message: string;
}

export type PaymentStatus = "DENIED" | "PENDING_APPROVAL" | "REJECTED" | "PROCESSING" | "SUCCESS" | "FAILED" | "REVERSED" | "UNKNOWN";

export interface PaymentRecord {
  paymentId: string;
  dealId: string;
  negotiationId: string;
  vendorId: string;
  payeeEmail: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  decision: "allow" | "deny" | "require_approval";
  summary: string;
  checks: CheckResult[];
  payoutBatchId?: string;
  events: { at: number; type: string; detail?: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface TranscriptEntry {
  negotiationId: string;
  seq: number;
  at: number;
  round: number;
  from: "buyer" | "seller";
  type: "open" | "offer" | "counter" | "accept" | "reject" | "walk_away" | "expired";
  sku: string;
  quantity: number;
  currency: string;
  unitPriceCents?: number;
  shippingCents?: number;
  totalCents?: number;
  expiresAt?: number;
  reasoning?: string;
  message?: string;
}

export interface PurchaseResult {
  outcome: string;
  error?: string;
  mandate?: Mandate;
  assumptions?: string[];
  product?: { sku: string; name: string; category: string; listUnitPriceCents: number };
  market?: { count: number; considered: number; minCents?: number; medianCents?: number; maxCents?: number };
  unitLimitCents?: number;
  negotiation?: { negotiationId: string; outcome: string; rounds: number; transcript: TranscriptEntry[] };
  payment?: PaymentRecord;
}

export interface PurchaseRun {
  runId: string;
  createdAt: number;
  request: { category: string; quantity: number; maxUnitPriceCents?: number };
  result: PurchaseResult;
}