import type { Mandate, ParsedMandate, PaymentRecord, PurchaseRun } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function messageFrom(body: any, status: number): string {
  if (body?.error === "validation" && Array.isArray(body.issues)) {
    return body.issues.map((i: any) => `${(i.path ?? []).join(".") || "input"}: ${i.message}`).join("; ");
  }
  if (typeof body?.error === "string") return body.error;
  return `Request failed (${status})`;
}

export interface ApiOptions {
  baseUrl?: string;
  /** Called on every request; return the x-api-key to send, if the server needs one. */
  getApiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export function createApi(o: ApiOptions = {}) {
  const base = o.baseUrl ?? "";
  const doFetch: typeof fetch = o.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    const key = o.getApiKey?.();
    if (key) headers["x-api-key"] = key;

    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, "Cannot reach the server. Is it running?");
    }
    const text = await res.text();
    let data: any = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) throw new ApiError(res.status, messageFrom(data, res.status));
    return data as T;
  }

  return {
    health: () => request<{ ok: boolean; mandateSet: boolean }>("GET", "/health"),
    parseMandate: (text: string) => request<ParsedMandate>("POST", "/api/mandate/parse", { text }),
    putMandate: (mandate: Mandate) => request<{ mandate: Mandate }>("PUT", "/api/mandate", mandate),
    getMandate: () => request<{ mandate: Mandate | null }>("GET", "/api/mandate"),
    purchase: (body: { category: string; quantity: number; maxUnitPriceCents?: number }) => request<PurchaseRun>("POST", "/api/purchase", body),
    listPurchases: () => request<{ purchases: PurchaseRun[] }>("GET", "/api/purchases"),
    listPayments: () => request<{ payments: PaymentRecord[] }>("GET", "/api/payments"),
    approvePayment: (id: string) => request<PaymentRecord>("POST", `/api/payments/${id}/approve`),
    rejectPayment: (id: string) => request<PaymentRecord>("POST", `/api/payments/${id}/reject`),
    syncPayment: (id: string) => request<PaymentRecord>("POST", `/api/payments/${id}/sync`),
    cancelPayment: (id: string) => request<PaymentRecord>("POST", `/api/payments/${id}/cancel`),
    requestRefund: (id: string, reason?: string) => request<PaymentRecord>("POST", `/api/payments/${id}/refund-request`, { reason }),
    refundReceived: (id: string) => request<PaymentRecord>("POST", `/api/payments/${id}/refund-received`),
  };
}

export type Api = ReturnType<typeof createApi>;