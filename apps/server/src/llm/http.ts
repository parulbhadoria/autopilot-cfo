const MAX_WAIT_MS = 15_000;
const DEFAULT_WAIT_MS = 2_000;
const CUSHION_MS = 250;

/** Reads how long the provider wants us to wait: Retry-After header, or "try again in 2.04s" in the message. */
export function parseWaitMs(headers: Headers, data: unknown): number | undefined {
  const h = headers.get("retry-after");
  if (h !== null && h.trim() !== "" && !Number.isNaN(Number(h))) return Number(h) * 1000;

  const msg = (data as any)?.error?.message;
  if (typeof msg !== "string") return undefined;
  const m = msg.match(/try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i);
  if (!m) return undefined;
  const unit: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  let total = 0;
  for (const part of m[1].matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)) total += Number(part[1]) * unit[part[2].toLowerCase()];
  return total;
}

export interface PostOptions {
  name: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  maxRetries: number;
}

/**
 * POSTs JSON and returns the parsed body. Retries rate limits (429) and server errors (5xx),
 * waiting as long as the provider asks. Gives up if the wait would exceed 15 s (e.g. a daily limit).
 */
export async function postJsonWithRetry(o: PostOptions): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await o.fetchImpl(o.url, {
      method: "POST",
      headers: o.headers,
      body: JSON.stringify(o.body),
      signal: AbortSignal.timeout(60_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) return data;

    const retriable = res.status === 429 || res.status >= 500;
    const wait = (parseWaitMs(res.headers, data) ?? DEFAULT_WAIT_MS) + CUSHION_MS;
    if (!retriable || attempt >= o.maxRetries || wait > MAX_WAIT_MS) {
      throw new Error(`${o.name} API error ${res.status}: ${JSON.stringify(data)}`);
    }
    await o.sleep(wait);
  }
}