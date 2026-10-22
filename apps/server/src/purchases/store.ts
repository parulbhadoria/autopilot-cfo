import { randomUUID } from "node:crypto";
import type { PurchaseResult } from "../pipeline/purchase.js";

export interface PurchaseRun {
  runId: string;
  createdAt: number;
  request: { category: string; quantity: number; maxUnitPriceCents?: number };
  result: PurchaseResult;
}

/** In-memory for now: every purchase run with its full negotiation transcript (the audit ledger reads this). */
export class PurchaseStore {
  private runs = new Map<string, PurchaseRun>();

  create(request: PurchaseRun["request"], result: PurchaseResult, now = Date.now()): PurchaseRun {
    const run: PurchaseRun = { runId: `run_${randomUUID()}`, createdAt: now, request, result };
    this.runs.set(run.runId, run);
    return run;
  }
  get(id: string) {
    return this.runs.get(id);
  }
  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}