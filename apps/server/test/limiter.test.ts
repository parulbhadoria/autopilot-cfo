import { describe, expect, it } from "vitest";
import { WindowLimiter, consumeAll } from "../src/limiter.js";

const HOUR = 3_600_000;
function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe("WindowLimiter", () => {
  it("allows up to max hits per key, then refuses", () => {
    const c = clock();
    const l = new WindowLimiter({ windowMs: HOUR, max: 2, now: c.now });
    expect([l.consume("a"), l.consume("a"), l.consume("a")]).toEqual([true, true, false]);
    expect(l.remaining("a")).toBe(0);
    expect(l.remaining("b")).toBe(2); // other keys are independent
  });

  it("frees a slot as the oldest hit leaves the window, and says how long to wait", () => {
    const c = clock();
    const l = new WindowLimiter({ windowMs: HOUR, max: 2, now: c.now });
    l.consume("a");
    c.t += 10 * 60_000;
    l.consume("a");
    expect(l.retryAfterMs("a")).toBe(50 * 60_000); // until the first hit is an hour old
    c.t += 50 * 60_000 + 1;
    expect(l.remaining("a")).toBe(1);
    expect(l.retryAfterMs("a")).toBe(0);
    expect(l.consume("a")).toBe(true);
  });

  it("max 0 means no limit", () => {
    const l = new WindowLimiter({ windowMs: HOUR, max: 0 });
    for (let i = 0; i < 1_000; i++) expect(l.consume("a")).toBe(true);
    expect(l.remaining("a")).toBe(Infinity);
  });

  it("refused attempts do not count against the key", () => {
    const c = clock();
    const l = new WindowLimiter({ windowMs: HOUR, max: 1, now: c.now });
    l.consume("a");
    for (let i = 0; i < 5; i++) l.consume("a");
    c.t += HOUR + 1;
    expect(l.consume("a")).toBe(true); // one hour after the single real hit
  });
});

describe("consumeAll", () => {
  it("records on every limiter, or on none if any refuses", () => {
    const c = clock();
    const perIp = new WindowLimiter({ windowMs: HOUR, max: 5, now: c.now });
    const total = new WindowLimiter({ windowMs: HOUR, max: 1, now: c.now });
    expect(consumeAll([{ limiter: perIp, key: "1.1.1.1" }, { limiter: total, key: "" }]).ok).toBe(true);
    const second = consumeAll([{ limiter: perIp, key: "2.2.2.2" }, { limiter: total, key: "" }]);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.limiter).toBe(total);
    expect(perIp.remaining("2.2.2.2")).toBe(5); // the per-address hit was not recorded
  });

  it("reports the first limiter that refuses", () => {
    const perIp = new WindowLimiter({ windowMs: HOUR, max: 1 });
    const total = new WindowLimiter({ windowMs: HOUR, max: 1 });
    perIp.consume("x");
    total.consume("");
    const r = consumeAll([{ limiter: perIp, key: "x" }, { limiter: total, key: "" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.limiter).toBe(perIp);
  });
});
