import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api";
import { LedgerScreen } from "../src/components/LedgerScreen";
import type { PurchaseRun } from "../src/types";

const t = (seq: number, from: "buyer" | "seller", type: any, unit: number, total: number, extra: any = {}) => ({
  negotiationId: "n", seq, at: 1_000 + seq, round: 1, from, type, sku: "s", quantity: 4, currency: "USD", unitPriceCents: unit, totalCents: total, ...extra,
});
const paidRun: PurchaseRun = {
  runId: "run_paid",
  createdAt: 2_000,
  request: { category: "sheet pans", quantity: 4 },
  result: {
    outcome: "payment_started",
    negotiation: { negotiationId: "n", outcome: "deal", rounds: 2, transcript: [t(0, "seller", "open", 3_000, 12_000), t(1, "buyer", "offer", 1_900, 7_600, { reasoning: "market is lower" }), t(2, "seller", "accept", 2_450, 9_800)] },
    payment: {
      paymentId: "p1", dealId: "d", negotiationId: "n", vendorId: "v", payeeEmail: "v@example.com", amountCents: 9_800, currency: "USD", status: "PROCESSING", decision: "allow", summary: "ok",
      checks: [{ id: "payee_matches", passed: true, onFail: "deny", message: "Payee matches the allowlisted vendor account." }], events: [], createdAt: 0, updatedAt: 0,
    },
  },
};
const blockedRun: PurchaseRun = {
  runId: "run_blocked",
  createdAt: 1_000,
  request: { category: "butter", quantity: 2 },
  result: {
    outcome: "payment_denied",
    negotiation: { negotiationId: "m", outcome: "deal", rounds: 1, transcript: [t(0, "seller", "open", 4_500, 9_000, { negotiationId: "m" })] },
    payment: {
      paymentId: "p2", dealId: "d2", negotiationId: "m", vendorId: "v", payeeEmail: "attacker@evil.example", amountCents: 9_800, currency: "USD", status: "DENIED", decision: "deny", summary: "Denied: payee_matches",
      checks: [{ id: "payee_matches", passed: false, onFail: "deny", message: "Payee does not match the allowlisted vendor account." }], events: [], createdAt: 0, updatedAt: 0,
    },
  },
};

const fakeApi = (runs: PurchaseRun[]) => ({ listPurchases: vi.fn().mockResolvedValue({ purchases: runs }) }) as unknown as Api & { listPurchases: any };

describe("LedgerScreen", () => {
  it("shows an empty state before any purchase", async () => {
    render(<LedgerScreen api={fakeApi([])} pollMs={60_000} />);
    expect(await screen.findByText(/No negotiations yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export negotiations/i })).toBeInTheDocument();
  });

  it("summarises paid money, savings and guardrail stops", async () => {
    render(<LedgerScreen api={fakeApi([paidRun, blockedRun])} pollMs={60_000} />);
    const stat = async (label: string) => (await screen.findByText(label)).parentElement!;
    expect(within(await stat("Negotiations")).getByText("2")).toBeInTheDocument();
    expect(within(await stat("Paid out")).getByText("$98.00")).toBeInTheDocument();
    expect(within(await stat("Negotiated savings")).getByText("$22.00")).toBeInTheDocument();
    expect(within(await stat("Stopped by guardrails")).getByText("1")).toBeInTheDocument();
  });

  const region = (name: string) => screen.getByRole("region", { name });
  const cells = (name: string) => Array.from(region(name).querySelectorAll(".ag-cell")).map((c) => c.textContent);

  it("shows the real negotiation rows in the grid, with money and plain-English outcomes", async () => {
    render(<LedgerScreen api={fakeApi([blockedRun, paidRun])} pollMs={60_000} />);
    await waitFor(() => expect(region("Negotiations").querySelectorAll(".ag-row").length).toBe(2));
    const text = region("Negotiations").textContent ?? "";
    expect(text).toContain("sheet pans");
    expect(text).toContain("Paid automatically");
    expect(text).toContain("Blocked by your rules");
    expect(text).toContain("$120.00"); // opening total
    expect(text).toContain("$98.00"); // final total / amount
    expect(text).toContain("$22.00"); // saved
    expect(text).toContain("Pays the right account"); // what stopped the blocked one
  });

  it("opens on the newest negotiation: its steps with the reasoning, and its passing check", async () => {
    render(<LedgerScreen api={fakeApi([blockedRun, paidRun])} pollMs={60_000} />);
    await waitFor(() => expect(screen.getByText(/4 x sheet pans\./)).toBeInTheDocument());
    await waitFor(() => expect(cells("Negotiation steps")).toContain("market is lower"));
    expect(cells("Negotiation steps")).toEqual(expect.arrayContaining(["Vendor", "Opens at", "Agent", "Offers", "$19.00", "$76.00"]));
    await waitFor(() => expect(cells("Policy check results")).toEqual(expect.arrayContaining(["Passed", "Pays the right account"])));
    expect(cells("Policy check results")).not.toContain("FAILED");
  });

  it("clicking another row switches the audit trail and checks to that negotiation", async () => {
    const user = userEvent.setup();
    render(<LedgerScreen api={fakeApi([blockedRun, paidRun])} pollMs={60_000} />);
    await waitFor(() => expect(cells("Negotiation steps")).toContain("market is lower"));

    const butterCell = Array.from(region("Negotiations").querySelectorAll(".ag-cell")).find((c) => c.textContent === "butter")!;
    await user.click(butterCell);

    await waitFor(() => expect(screen.getByText(/2 x butter\./)).toBeInTheDocument());
    await waitFor(() => expect(cells("Policy check results")).toContain("FAILED"));
    expect(cells("Policy check results")).toContain("Payee does not match the allowlisted vendor account.");
    // AG Grid animates old rows out, so wait for them to leave the DOM.
    await waitFor(() => expect(cells("Negotiation steps")).not.toContain("market is lower"));
  });

  it("shows a friendly error when the ledger cannot load", async () => {
    const api = { listPurchases: vi.fn().mockRejectedValue(new Error("Cannot reach the server. Is it running?")) } as unknown as Api;
    render(<LedgerScreen api={api} pollMs={60_000} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the server");
  });

  it("refreshes on demand", async () => {
    const user = userEvent.setup();
    const api = fakeApi([paidRun]);
    render(<LedgerScreen api={api} pollMs={60_000} />);
    await screen.findByText("Negotiations");
    const before = api.listPurchases.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /^refresh$/i }));
    await waitFor(() => expect(api.listPurchases.mock.calls.length).toBe(before + 1));
  });
});