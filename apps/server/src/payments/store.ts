import type { CheckResult, Decision } from "@autopilot/guardrail";

export type PaymentStatus =
  | "DENIED"
  | "PENDING_APPROVAL"
  | "REJECTED"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "REVERSED"
  | "UNKNOWN";

export interface PaymentEvent {
  at: number;
  type: string;
  detail?: string;
}

export interface PaymentRecord {
  paymentId: string;
  dealId: string;
  negotiationId: string;
  vendorId: string;
  payeeEmail: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  decision: Decision;
  summary: string;
  checks: CheckResult[];
  deal: unknown;
  request: unknown;
  senderBatchId?: string;
  payoutBatchId?: string;
  events: PaymentEvent[];
  createdAt: number;
  updatedAt: number;
}

/** In-memory for Week 1. Week 3 swaps this for persistent storage behind the same methods. */
export class PaymentStore {
  private records = new Map<string, PaymentRecord>();

  create(rec: PaymentRecord) {
    this.records.set(rec.paymentId, rec);
    return rec;
  }
  get(id: string) {
    return this.records.get(id);
  }
  list() {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  findByDeal(dealId: string) {
    return this.list().filter((r) => r.dealId === dealId);
  }
  findByBatch(id: string) {
    return this.list().find((r) => r.payoutBatchId === id || r.senderBatchId === id);
  }
  update(id: string, patch: Partial<PaymentRecord>, event?: Omit<PaymentEvent, "at">, now = Date.now()) {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`Unknown payment ${id}`);
    Object.assign(rec, patch, { updatedAt: now });
    if (event) rec.events.push({ at: now, ...event });
    return rec;
  }
}
