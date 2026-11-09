const KEY = "autopilot-session";
const VALID = /^[A-Za-z0-9_-]{8,64}$/;

function makeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("-"); // old browsers
}

/** This browser's visitor id, created once and remembered. The server keeps each visitor's state separate. */
export function getSessionId(storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage()): string {
  try {
    const existing = storage?.getItem(KEY);
    if (existing && VALID.test(existing)) return existing;
  } catch {
    /* storage unavailable: fall through to a fresh id */
  }
  const id = makeId();
  try {
    storage?.setItem(KEY, id);
  } catch {
    /* the id then lasts only for this page load */
  }
  return id;
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
