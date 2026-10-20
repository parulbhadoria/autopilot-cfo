import { config } from "../config.js";

let cached: { token: string; expiresAt: number } | null = null;

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
    public debugId: string | null,
  ) {
    super(message);
  }
}

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 30_000) return cached.token;

  const basic = Buffer.from(`${config.clientId()}:${config.clientSecret()}`).toString("base64");
  const res = await fetch(`${config.paypalBaseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data: any = await res.json();
  if (!res.ok) {
    throw new PayPalError("OAuth failed", res.status, data, res.headers.get("paypal-debug-id"));
  }
  cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

interface Opts {
  method?: "GET" | "POST";
  body?: unknown;
  /** Idempotency key. Same key + same body = PayPal will not duplicate the action. */
  requestId?: string;
}

export async function paypalFetch<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;

  const res = await fetch(`${config.paypalBaseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new PayPalError(
      `PayPal ${opts.method ?? "GET"} ${path} failed (${res.status})`,
      res.status,
      data,
      res.headers.get("paypal-debug-id"),
    );
  }
  return data as T;
}

export function printError(e: unknown): void {
  if (e instanceof PayPalError) {
    console.error(`\n${e.message}`);
    console.error("debug id:", e.debugId);
    console.error("body:", JSON.stringify(e.body, null, 2));
  } else {
    console.error(e);
  }
}
