export interface SpendRecord {
  dealId: string;
  vendorId: string;
  amountCents: number;
  currency: string;
  /** Epoch ms */
  at: number;
}

export interface SpendLedger {
  all(): readonly SpendRecord[];
  has(dealId: string): boolean;
  add(rec: SpendRecord): void;
  remove(dealId: string): void;
}

export const HOUR_MS = 3_600_000;
export const WEEK_MS = 7 * 24 * HOUR_MS;

export class InMemoryLedger implements SpendLedger {
  private records: SpendRecord[] = [];
  all() {
    return this.records;
  }
  has(dealId: string) {
    return this.records.some((r) => r.dealId === dealId);
  }
  add(rec: SpendRecord) {
    this.records.push(rec);
  }
  remove(dealId: string) {
    this.records = this.records.filter((r) => r.dealId !== dealId);
  }
}

export function sumSpend(ledger: SpendLedger, sinceMs: number, vendorId?: string): number {
  return ledger
    .all()
    .filter((r) => r.at > sinceMs && (vendorId === undefined || r.vendorId === vendorId))
    .reduce((acc, r) => acc + r.amountCents, 0);
}
