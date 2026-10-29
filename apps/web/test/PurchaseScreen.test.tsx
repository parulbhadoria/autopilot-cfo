import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api";
import { PurchaseScreen } from "../src/components/PurchaseScreen";
import type { PurchaseRun } from "../src/types";

const run = (over: Partial<PurchaseRun["result"]> = {}, id = "run_1"): PurchaseRun => ({
  runId: id,
  createdAt: Date.now(),
  request: { category: "sheet pans", quantity: 4 },
  result: {
    outcome: "payment_started",
    product: { sku: "sheet-pan-half", name: "Aluminum half-size sheet pan", category: "sheet pans", listUnitPriceCents: 3_000 },
    unitLimitCents: 2_499,
    market: { count: 13, considered: 13, medianCents: 2_799, minCents: 1_595, maxCents: 4_000 },
    negotiation: {
      negotiationId: "n",
      outcome: "deal",
      rounds: 3,
      transcript: [
        { negotiationId: "n", seq: 0, at: 0, round: 0, from: "seller", type: "open", sku: "s", quantity: 4, currency: "USD", unitPriceCents: 3_000, totalCents: 12_000 },
        { negotiationId: "n", seq: 1, at: 0, round: 1, from: "buyer", type: "offer", sku: "s", quantity: 4, currency: "USD", unitPriceCents: 1_900, totalCents: 7_600, reasoning: "market is lower" },
        { negotiationId: "n", seq: 2, at: 0, round: 3, from: "seller", type: "accept", sku: "s", quantity: 4, currency: "USD", unitPriceCents: 2_450, totalCents: 9_800, message: "Deal" },
      ],
    },
    payment: {
      paymentId: "pay_1", dealId: "d", negotiationId: "n", vendorId: "sunrise", payeeEmail: "v@example.com", amountCents: 9_800, currency: "USD",
      status: "PROCESSING", decision: "allow", summary: "All policy checks passed.", checks: [], events: [], createdAt: 0, updatedAt: 0,
    },
    ...over,
  },
});

function fakeApi(over: Partial<Record<keyof Api, any>> = {}) {
  return {
    listPurchases: vi.fn().mockResolvedValue({ purchases: [] }),
    purchase: vi.fn().mockResolvedValue(run()),
    approvePayment: vi.fn(),
    rejectPayment: vi.fn(),
    ...over,
  } as unknown as Api & { purchase: any; approvePayment: any; rejectPayment: any };
}

describe("PurchaseScreen", () => {
  it("runs a purchase and shows the negotiation in plain English", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<PurchaseScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /buy now/i }));

    expect(api.purchase).toHaveBeenCalledWith({ category: "sheet pans", quantity: 4 });
    expect((await screen.findAllByText(/Paid automatically/i)).length).toBeGreaterThan(0);
    expect(screen.getByText("Vendor opens with its price")).toBeInTheDocument();
    expect(screen.getByText("Your agent offers 19.00 per unit")).toBeInTheDocument();
    expect(screen.getByText("market is lower")).toBeInTheDocument();
    expect(screen.getAllByText("$98.00").length).toBeGreaterThan(0);
    expect(screen.getByText(/market median \$27\.99 from 13 listings/)).toBeInTheDocument();
  });

  it("sends the optional max-per-unit price in cents", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<PurchaseScreen api={api} />);
    await user.type(screen.getByLabelText(/max per unit/i), "24.50");
    await user.click(screen.getByRole("button", { name: /buy now/i }));
    expect(api.purchase).toHaveBeenCalledWith({ category: "sheet pans", quantity: 4, maxUnitPriceCents: 2_450 });
  });

  it("blocks invalid quantities and prices before calling the server", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<PurchaseScreen api={api} />);
    const qty = screen.getByLabelText(/quantity/i);
    await user.clear(qty);
    await user.type(qty, "0");
    expect(screen.getByText(/whole number from 1 to 10,000/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /buy now/i })).toBeDisabled();

    await user.clear(qty);
    await user.type(qty, "4");
    await user.type(screen.getByLabelText(/max per unit/i), "abc");
    expect(screen.getByText(/must be an amount/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /buy now/i })).toBeDisabled();
    expect(api.purchase).not.toHaveBeenCalled();
  });

  it("lets the owner approve a held order, then shows it as paid", async () => {
    const user = userEvent.setup();
    const held = run({ outcome: "awaiting_approval", payment: { ...run().result.payment!, status: "PENDING_APPROVAL", decision: "require_approval", amountCents: 14_000 } });
    const api = fakeApi({
      purchase: vi.fn().mockResolvedValue(held),
      approvePayment: vi.fn().mockResolvedValue({ ...held.result.payment!, status: "PROCESSING", decision: "allow" }),
    });
    render(<PurchaseScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /buy now/i }));
    await user.click(await screen.findByRole("button", { name: /approve \$140\.00/i }));

    await waitFor(() => expect(api.approvePayment).toHaveBeenCalledWith("pay_1"));
    expect((await screen.findAllByText(/Paid automatically/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });

  it("shows the truth when approving is refused on the server's re-check", async () => {
    const user = userEvent.setup();
    const held = run({ outcome: "awaiting_approval", payment: { ...run().result.payment!, status: "PENDING_APPROVAL", decision: "require_approval", amountCents: 14_000 } });
    const denied = {
      ...held.result.payment!,
      status: "DENIED",
      decision: "deny",
      summary: "Denied: weekly_budget",
      checks: [{ id: "weekly_budget", passed: false, onFail: "deny", message: "Spent $300.00 this week; adding $140.00 exceeds $400.00." }],
    };
    const api = fakeApi({ purchase: vi.fn().mockResolvedValue(held), approvePayment: vi.fn().mockResolvedValue(denied) });
    render(<PurchaseScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /buy now/i }));
    await user.click(await screen.findByRole("button", { name: /approve \$140\.00/i }));
    expect((await screen.findAllByText(/Blocked by your rules/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/exceeds \$400\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/Paid automatically/i)).not.toBeInTheDocument();
  });

  it("lets the owner reject a held order", async () => {
    const user = userEvent.setup();
    const held = run({ outcome: "awaiting_approval", payment: { ...run().result.payment!, status: "PENDING_APPROVAL", decision: "require_approval", amountCents: 14_000 } });
    const api = fakeApi({
      purchase: vi.fn().mockResolvedValue(held),
      rejectPayment: vi.fn().mockResolvedValue({ ...held.result.payment!, status: "REJECTED" }),
    });
    render(<PurchaseScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /buy now/i }));
    await user.click(await screen.findByRole("button", { name: /^reject$/i }));
    await waitFor(() => expect(api.rejectPayment).toHaveBeenCalledWith("pay_1"));
    expect((await screen.findAllByText(/You rejected this order/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Paid automatically/i)).not.toBeInTheDocument();
  });
    it("shows payment actions under a paid order and updates the screen from PayPal's answer", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      syncPayment: vi.fn().mockResolvedValue({ ...run().result.payment!, status: "SUCCESS", payoutBatchId: "B1", payoutItemStatus: "SUCCESS" }),
    });
    (api.purchase as any).mockResolvedValue({ ...run(), result: { ...run().result, payment: { ...run().result.payment!, payoutBatchId: "B1" } } });
    render(<PurchaseScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /buy now/i }));
    await user.click(await screen.findByRole("button", { name: /check paypal status/i }));
    await waitFor(() => expect(api.syncPayment).toHaveBeenCalledWith("pay_1"));
    expect(await screen.findByRole("button", { name: /request refund from vendor/i })).toBeInTheDocument();
    expect(screen.getByText(/PayPal says: success/i)).toBeInTheDocument();
  });

  it("a cancelled order is reported as money returned, in the banner and the history", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ cancelPayment: vi.fn().mockResolvedValue({ ...run().result.payment!, status: "REVERSED", payoutBatchId: "B1", payoutItemStatus: "RETURNED" }) });
    (api.purchase as any).mockResolvedValue({ ...run(), result: { ...run().result, payment: { ...run().result.payment!, payoutBatchId: "B1", payoutItemStatus: "UNCLAIMED", payoutBatchStatus: "SUCCESS" } } });
    render(<PurchaseScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /buy now/i }));
    await user.click(await screen.findByRole("button", { name: /cancel payout and return my money/i }));
    expect((await screen.findAllByText(/cancelled or refunded/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Paid automatically/i)).not.toBeInTheDocument();
  });

  it("shows a clear message when the purchase fails", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ purchase: vi.fn().mockRejectedValue(new Error("No active mandate. PUT /api/mandate first.")) });
    render(<PurchaseScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /buy now/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No active mandate");
  });

  it("loads history and lets the owner reopen an earlier run", async () => {
    const user = userEvent.setup();
    const old = run({ outcome: "no_deal", negotiation: { negotiationId: "n", outcome: "seller_walked_away", rounds: 4, transcript: [] }, payment: undefined }, "run_old");
    const api = fakeApi({ listPurchases: vi.fn().mockResolvedValue({ purchases: [old] }) });
    render(<PurchaseScreen api={api} />);
    // History shows a short label; the full sentence appears only after the owner opens the run.
    expect(await screen.findByText("No deal")).toBeInTheDocument();
    expect(screen.queryByText(/No deal\. The agent could not agree/i)).not.toBeInTheDocument();
    await user.click(screen.getByText("sheet pans", { selector: "td" }));
    expect(await screen.findByText(/No deal\. The agent could not agree/i)).toBeInTheDocument();
  });
});