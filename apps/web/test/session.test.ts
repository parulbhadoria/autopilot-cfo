import { describe, expect, it } from "vitest";
import { getSessionId } from "../src/lib/session";

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
};

describe("getSessionId", () => {
  it("creates an id once and then keeps returning the same one", () => {
    const s = memory();
    const a = getSessionId(s);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(getSessionId(s)).toBe(a);
    expect(s.data["autopilot-session"]).toBe(a);
  });

  it("ignores a stored id the server would reject", () => {
    const s = memory({ "autopilot-session": "bad id!" });
    const id = getSessionId(s);
    expect(id).not.toBe("bad id!");
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("different browsers get different ids", () => {
    expect(getSessionId(memory())).not.toBe(getSessionId(memory()));
  });

  it("still works when storage is blocked", () => {
    const blocked = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(getSessionId(blocked)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(getSessionId(undefined)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
