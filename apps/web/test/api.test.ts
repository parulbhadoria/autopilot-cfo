import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/api";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(response: Response | (() => Response | Promise<Response>)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? response() : response.clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("api client", () => {
  it("sends the right method, path and JSON body", async () => {
    const { fetchImpl, calls } = recorder(json({ mandate: null }));
    const api = createApi({ fetchImpl });
    await api.getMandate();
    expect(calls[0].url).toBe("/api/mandate");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();

    const r2 = recorder(json({ mandate: { mandateId: "m" }, assumptions: [] }));
    await createApi({ fetchImpl: r2.fetchImpl }).parseMandate("keep flour stocked");
    expect(r2.calls[0].url).toBe("/api/mandate/parse");
    expect(r2.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(r2.calls[0].init.body))).toEqual({ text: "keep flour stocked" });
    expect((r2.calls[0].init.headers as any)["content-type"]).toBe("application/json");
  });

  it("uses the base URL and routes approve / reject / purchase", async () => {
    const { fetchImpl, calls } = recorder(json({}));
    const api = createApi({ baseUrl: "https://demo.example.com", fetchImpl });
    await api.approvePayment("pay_1");
    await api.rejectPayment("pay_2");
    await api.purchase({ category: "sheet pans", quantity: 4 });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST https://demo.example.com/api/payments/pay_1/approve",
      "POST https://demo.example.com/api/payments/pay_2/reject",
      "POST https://demo.example.com/api/purchase",
    ]);
  });

  it("adds x-api-key only when a key is set", async () => {
    const withKey = recorder(json({ ok: true, mandateSet: false }));
    await createApi({ fetchImpl: withKey.fetchImpl, getApiKey: () => "secret" }).health();
    expect((withKey.calls[0].init.headers as any)["x-api-key"]).toBe("secret");

    const noKey = recorder(json({ ok: true, mandateSet: false }));
    await createApi({ fetchImpl: noKey.fetchImpl, getApiKey: () => undefined }).health();
    expect((noKey.calls[0].init.headers as any)["x-api-key"]).toBeUndefined();
  });

  it("turns server errors into readable ApiErrors", async () => {
    const simple = recorder(json({ error: "None of the requested items are sold by this vendor." }, 422));
    await expect(createApi({ fetchImpl: simple.fetchImpl }).parseMandate("x")).rejects.toMatchObject({ status: 422, message: "None of the requested items are sold by this vendor." });

    const validation = recorder(json({ error: "validation", issues: [{ path: ["autoApproveUnderCents"], message: "must be lower" }, { path: [], message: "bad" }] }, 400));
    await expect(createApi({ fetchImpl: validation.fetchImpl }).putMandate({} as any)).rejects.toThrow("autoApproveUnderCents: must be lower; input: bad");

    const unauth = recorder(json({ error: "missing or bad x-api-key" }, 401));
    await expect(createApi({ fetchImpl: unauth.fetchImpl }).listPayments()).rejects.toBeInstanceOf(ApiError);
  });

  it("handles non-JSON error bodies and network failures", async () => {
    const html = recorder(new Response("<html>oops</html>", { status: 502 }));
    await expect(createApi({ fetchImpl: html.fetchImpl }).health()).rejects.toMatchObject({ status: 502, message: "Request failed (502)" });

    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(createApi({ fetchImpl: down }).health()).rejects.toMatchObject({ status: 0, message: "Cannot reach the server. Is it running?" });
  });
});