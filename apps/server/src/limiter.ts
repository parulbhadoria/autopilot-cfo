/**
 * A sliding-window counter: at most `max` hits per key within `windowMs`. max <= 0 means no limit.
 * Used to keep a public demo from running up costs.
 */
export class WindowLimiter {
  private hits = new Map<string, number[]>();
  readonly max: number;
  private windowMs: number;
  private now: () => number;

  constructor(o: { windowMs: number; max: number; now?: () => number }) {
    this.max = o.max;
    this.windowMs = o.windowMs;
    this.now = o.now ?? Date.now;
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  /** How many more hits this key may make right now. Infinity when unlimited. */
  remaining(key = ""): number {
    return this.max > 0 ? Math.max(0, this.max - this.recent(key).length) : Infinity;
  }

  /** Milliseconds until this key may hit again (0 if it can now). */
  retryAfterMs(key = ""): number {
    if (this.remaining(key) > 0) return 0;
    return Math.max(0, this.recent(key)[0] + this.windowMs - this.now());
  }

  /** Records a hit if allowed. */
  consume(key = ""): boolean {
    if (this.remaining(key) <= 0) return false;
    if (this.max > 0) {
      if (this.hits.size > 10_000) for (const k of [...this.hits.keys()]) this.recent(k); // forget idle keys
      const list = this.hits.get(key) ?? [];
      list.push(this.now());
      this.hits.set(key, list);
    }
    return true;
  }
}

export type LimitCheck = { limiter: WindowLimiter; key: string };

/** All-or-nothing: records a hit on every limiter, or on none of them if any one refuses. */
export function consumeAll(checks: LimitCheck[]): { ok: true } | { ok: false; limiter: WindowLimiter; retryAfterMs: number } {
  for (const c of checks) {
    if (c.limiter.remaining(c.key) <= 0) return { ok: false, limiter: c.limiter, retryAfterMs: c.limiter.retryAfterMs(c.key) };
  }
  for (const c of checks) c.limiter.consume(c.key);
  return { ok: true };
}
