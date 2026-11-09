import { InMemoryLedger, type Mandate, type SpendLedger } from "@autopilot/guardrail";
import { PaymentStore, type PaymentRecord } from "./payments/store.js";
import { PurchaseStore } from "./purchases/store.js";

/** Requests with no (or an invalid) session id share this one. It is what scripts and local tools use. */
export const DEFAULT_SESSION = "default";

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const isValidSessionId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

/** Everything one visitor owns. Visitors never see or spend each other's money, rules or history. */
export interface Session {
  id: string;
  mandate: Mandate | null;
  ledger: SpendLedger;
  store: PaymentStore;
  purchases: PurchaseStore;
  lastUsed: number;
}

export interface SessionOptions {
  /** A session idle this long is forgotten (unless a payment is still in flight). Default 2 hours. */
  ttlMs?: number;
  /** Upper bound on remembered sessions; the least recently used go first. Default 300. */
  maxSessions?: number;
  now?: () => number;
  /** State for the "default" session, so a single-user setup can keep passing its own store and ledger. */
  seed?: { ledger?: SpendLedger; store?: PaymentStore; purchases?: PurchaseStore; mandate?: Mandate | null };
}

/** A payment PayPal may still be updating. Sessions holding one are kept so webhooks and status checks can land. */
const HOLDS_LIVE_PAYMENT_MS = 60 * 60_000;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private ttlMs: number;
  private maxSessions: number;
  private now: () => number;
  private seed: SessionOptions["seed"];

  constructor(o: SessionOptions = {}) {
    this.ttlMs = o.ttlMs ?? 2 * 60 * 60_000;
    this.maxSessions = o.maxSessions ?? 300;
    this.now = o.now ?? Date.now;
    this.seed = o.seed;
  }

  get size() {
    return this.sessions.size;
  }

  peek(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** The session for this id, created on first use. */
  get(id: string): Session {
    this.sweep();
    let s = this.sessions.get(id);
    if (!s) {
      s = this.fresh(id, id === DEFAULT_SESSION);
      this.sessions.set(id, s);
      this.evictOverflow(id);
    }
    s.lastUsed = this.now();
    return s;
  }

  /** Throws away everything this visitor has and starts them over. */
  reset(id: string): Session {
    const s = this.fresh(id, false);
    s.lastUsed = this.now();
    this.sessions.set(id, s);
    return s;
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  /** Finds a payment by PayPal's batch id (or our sender batch id) in any session. Used by webhooks. */
  findPayment(key: string): { session: Session; rec: PaymentRecord } | undefined {
    for (const session of this.sessions.values()) {
      const rec = session.store.findByBatch(key);
      if (rec) return { session, rec };
    }
    return undefined;
  }

  private fresh(id: string, useSeed: boolean): Session {
    const seed = useSeed ? this.seed : undefined;
    return {
      id,
      mandate: seed?.mandate ?? null,
      ledger: seed?.ledger ?? new InMemoryLedger(),
      store: seed?.store ?? new PaymentStore(),
      purchases: seed?.purchases ?? new PurchaseStore(),
      lastUsed: this.now(),
    };
  }

  private holdsLivePayment(s: Session): boolean {
    const t = this.now();
    return s.store.list().some((r) => (r.status === "PROCESSING" || r.status === "UNKNOWN") && r.payoutBatchId && t - r.createdAt < HOLDS_LIVE_PAYMENT_MS);
  }

  private removable(s: Session): boolean {
    return s.id !== DEFAULT_SESSION && !this.holdsLivePayment(s);
  }

  private sweep() {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      if (t - s.lastUsed > this.ttlMs && this.removable(s)) this.sessions.delete(id);
    }
  }

  private evictOverflow(keep: string) {
    if (this.sessions.size <= this.maxSessions) return;
    const candidates = [...this.sessions.values()].filter((s) => s.id !== keep && this.removable(s)).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const s of candidates) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(s.id);
    }
  }
}
