import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";

afterEach(() => vi.unstubAllGlobals());

describe("App shell", () => {
  it("shows the title, the server status and the mandate screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("health") ? { ok: true, mandateSet: false } : { mandate: null }), { status: 200 })),
    );
    render(<App />);
    expect(screen.getByRole("heading", { name: /autopilot cfo/i })).toBeInTheDocument();
    expect(await screen.findByText(/Server online/i)).toBeInTheDocument();
    expect(await screen.findByText(/No mandate yet/i)).toBeInTheDocument();
  });

  it("says so when the server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    render(<App healthRetryMs={5} healthTries={3} />);
    expect(await screen.findByText(/Server offline/i)).toBeInTheDocument();
  });
});

describe("App tabs", () => {
  it("opens the ledger tab on demand", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("health") ? { ok: true, mandateSet: false } : url.includes("purchases") ? { purchases: [] } : { mandate: null };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const { default: userEvent } = await import("@testing-library/user-event");
    render(<App />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Ledger" }));
    expect(await screen.findByText(/No negotiations yet/i, undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /audit ledger/i })).toBeInTheDocument();
  });
});

describe("App on free hosting and in the public demo", () => {
  it("keeps trying while the server wakes up, then goes online", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("health")) {
          if (++calls < 3) throw new TypeError("fetch failed");
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ mandate: null, demoMode: false }), { status: 200 });
      }),
    );
    render(<App healthRetryMs={5} healthTries={10} />);
    expect(await screen.findByText(/Waking up the server/i)).toBeInTheDocument();
    expect(await screen.findByText(/Server online/i)).toBeInTheDocument();
    expect(calls).toBe(3);
  });

  it("sends the same visitor id on every request", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push(String((init.headers as any)?.["x-session-id"]));
        return new Response(JSON.stringify(url.includes("health") ? { ok: true } : { mandate: null, demoMode: false }), { status: 200 });
      }),
    );
    render(<App />);
    await screen.findByText(/No mandate yet/i);
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("shows the demo banner and the one-click rules, and Reset wipes the visitor's data", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("health")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (url.endsWith("/api/demo")) return new Response(JSON.stringify({ demoMode: true, remaining: { purchases: 4 } }), { status: 200 });
        if (url.endsWith("/api/demo/reset")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response(JSON.stringify({ mandate: null }), { status: 200 });
      }),
    );
    render(<App />);
    expect(await screen.findByText(/no real money moves/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /start with the demo rules/i })).toBeInTheDocument();

    const mandateLoads = () => calls.filter((c) => c === "GET /api/mandate").length;
    const before = mandateLoads();
    await userEvent.setup().click(screen.getByRole("button", { name: /reset my demo/i }));
    await vi.waitFor(() => expect(calls).toContain("POST /api/demo/reset"));
    await vi.waitFor(() => expect(mandateLoads()).toBe(before + 1)); // the screen reloaded its data
  });
});
