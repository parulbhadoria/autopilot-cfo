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
    render(<App />);
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