import { syncPayment, type PaymentDeps } from "./service.js";

const signature = (r: { status: string; payoutItemStatus?: string; payoutBatchStatus?: string }) => [r.status, r.payoutItemStatus, r.payoutBatchStatus].join("|");

/**
 * One pass over payments that were sent but are not final yet: ask PayPal where each stands.
 * This is the safety net behind webhooks (a missed or delayed webhook is picked up here) and it is
 * what keeps statuses live when no webhook is configured at all. Payments older than maxAgeMs are
 * left alone; the owner can still press "Check PayPal status" for those.
 */
export async function reconcileOnce(deps: PaymentDeps, o: { maxAgeMs?: number } = {}): Promise<{ checked: number; changed: number; errors: number }> {
  const now = deps.now?.() ?? Date.now();
  const maxAge = o.maxAgeMs ?? 30 * 60_000;
  const pending = deps.store.list().filter((r) => (r.status === "PROCESSING" || r.status === "UNKNOWN") && r.payoutBatchId && now - r.createdAt <= maxAge);

  let changed = 0;
  let errors = 0;
  for (const r of pending) {
    const before = signature(r);
    try {
      const after = await syncPayment(deps, r.paymentId);
      if (signature(after) !== before) changed++;
    } catch {
      errors++; // one bad lookup must not stop the others
    }
  }
  return { checked: pending.length, changed, errors };
}

/** Runs reconcileOnce on a timer, never two at once. Returns a function that stops it. intervalMs <= 0 turns it off. */
export function startReconciler(deps: PaymentDeps, o: { intervalMs: number; maxAgeMs?: number; log?: (message: string) => void }): () => void {
  if (!(o.intervalMs > 0)) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await reconcileOnce(deps, { maxAgeMs: o.maxAgeMs });
      if (r.changed > 0 || r.errors > 0) o.log?.(`payment sync: checked ${r.checked}, updated ${r.changed}, errors ${r.errors}`);
    } finally {
      running = false;
    }
  };
  const id = setInterval(tick, o.intervalMs);
  id.unref?.(); // never keep the process alive just for this timer
  return () => clearInterval(id);
}