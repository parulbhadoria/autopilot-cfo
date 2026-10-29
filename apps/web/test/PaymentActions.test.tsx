import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../src/api";
import { PaymentActions } from "../src/components/PaymentActions";
import type { PaymentRecord } from "../src/types";

const payment = (over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  paymentId: "pay_1", dealId: "d", negotiationId: "n", vendorId: "v", payeeEmail: "v@example.com", amountCents: 9_800, currency: "USD",
  status: "PROCESSING", decision: "allow", summary: "ok", checks: [], payoutBatchId: "BATCH1", events: [], createdAt: 0, updatedAt: 0, ...over,
});

/** The parent owns the payment, as it does in the app, so updates flow back in. */
function Harness({ api, initial }: { api: Api; initial: PaymentRecord }) {
  const [p, setP] = useState(initial);
  return <PaymentActions payment={p} api={api} onUpdated={setP} />;
}
const fakeApi = (over: Partial<Record<keyof Api, any>> = {}) => ({ syncPayment: vi.fn(), cancelPayment: vi.fn(), requestRefund: vi.fn(), refundReceived: vi.fn(), ...over }) as unknown as Api & Record<string, any>;

describe("PaymentActions", () => {
  it("shows nothing for a payment that was never sent", () => {
    const { container } = render(<PaymentActions payment={payment({ status: "PENDING_APPROVAL", payoutBatchId: undefined })} api={fakeApi()} onUpdated={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("checks PayPal and shows what PayPal says", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ syncPayment: vi.fn().mockResolvedValue(payment({ status: "SUCCESS", payoutItemStatus: "SUCCESS" })) });
    render(<Harness api={api} initial={payment()} />);
    await user.click(screen.getByRole("button", { name: /check paypal status/i }));
    await waitFor(() => expect(api.syncPayment).toHaveBeenCalledWith("pay_1"));
    expect(await screen.findByText(/PayPal says: success/i)).toBeInTheDocument();
  });

  it("offers Cancel only when the vendor has not claimed the payout, and explains why", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ cancelPayment: vi.fn().mockResolvedValue(payment({ status: "REVERSED", payoutItemStatus: "RETURNED" })) });
    render(<Harness api={api} initial={payment({ payoutItemStatus: "UNCLAIMED", payoutBatchStatus: "SUCCESS" })} />);
    expect(screen.getByText(/has not claimed this payment/i)).toBeInTheDocument();
    expect(screen.getByText(/may not have a PayPal account/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /cancel payout and return my money/i }));
    await waitFor(() => expect(api.cancelPayment).toHaveBeenCalledWith("pay_1"));
    expect(await screen.findByText(/Payout cancelled\. The money is back/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel payout/i })).not.toBeInTheDocument();
  });

  it("does not offer Cancel yet while PayPal is still finishing the batch, and says why", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ syncPayment: vi.fn().mockResolvedValue(payment({ payoutItemStatus: "UNCLAIMED", payoutBatchStatus: "SUCCESS" })) });
    render(<Harness api={api} initial={payment({ payoutItemStatus: "UNCLAIMED", payoutBatchStatus: "PROCESSING" })} />);
    expect(screen.getByText(/has not claimed this payment/i)).toBeInTheDocument();
    expect(screen.getByText(/still finishing this payout batch/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel payout/i })).not.toBeInTheDocument();

    // After the next status check PayPal reports the batch as processed, and Cancel appears.
    await user.click(screen.getByRole("button", { name: /check paypal status/i }));
    expect(await screen.findByRole("button", { name: /cancel payout and return my money/i })).toBeInTheDocument();
    expect(screen.queryByText(/still finishing this payout batch/i)).not.toBeInTheDocument();
  });

  it("never offers Cancel for a payout that was delivered, and is upfront that it cannot be reversed", () => {
    render(<Harness api={fakeApi()} initial={payment({ status: "SUCCESS", payoutItemStatus: "SUCCESS" })} />);
    expect(screen.queryByRole("button", { name: /cancel payout/i })).not.toBeInTheDocument();
    expect(screen.getByText(/PayPal cannot reverse a payment once it is delivered/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request refund from vendor/i })).toBeInTheDocument();
  });

  it("records a refund request with the reason, then lets the owner confirm the money arrived", async () => {
    const user = userEvent.setup();
    const requested = payment({ status: "SUCCESS", refund: { state: "REQUESTED", requestedAt: 1_700_000_000_000, reason: "wrong pans" } });
    const api = fakeApi({
      requestRefund: vi.fn().mockResolvedValue(requested),
      refundReceived: vi.fn().mockResolvedValue({ ...requested, status: "REVERSED", refund: { ...requested.refund!, state: "RECEIVED", receivedAt: 1_700_000_100_000 } }),
    });
    render(<Harness api={api} initial={payment({ status: "SUCCESS" })} />);

    await user.type(screen.getByLabelText(/reason for a refund/i), "wrong pans");
    await user.click(screen.getByRole("button", { name: /request refund from vendor/i }));
    await waitFor(() => expect(api.requestRefund).toHaveBeenCalledWith("pay_1", "wrong pans"));
    expect(await screen.findByText(/Refund requested from the vendor/i)).toBeInTheDocument();
    expect(screen.getByText(/the vendor has to send the money/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /request refund from vendor/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /i received the money back/i }));
    await waitFor(() => expect(api.refundReceived).toHaveBeenCalledWith("pay_1"));
    expect(await screen.findByText(/Refund received/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer counts against your weekly budget/i)).toBeInTheDocument();
  });

  it("sends no reason when the box is empty", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ requestRefund: vi.fn().mockResolvedValue(payment({ status: "SUCCESS", refund: { state: "REQUESTED", requestedAt: 1 } })) });
    render(<Harness api={api} initial={payment({ status: "SUCCESS" })} />);
    await user.click(screen.getByRole("button", { name: /request refund from vendor/i }));
    await waitFor(() => expect(api.requestRefund).toHaveBeenCalledWith("pay_1", undefined));
  });

  it("shows the server's plain explanation when an action is refused", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ cancelPayment: vi.fn().mockRejectedValue(new ApiError(409, "This payout was already delivered. PayPal cannot reverse a delivered payout.")) });
    render(<Harness api={api} initial={payment({ payoutItemStatus: "UNCLAIMED", payoutBatchStatus: "SUCCESS" })} />);
    await user.click(screen.getByRole("button", { name: /cancel payout/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already delivered");
    expect(screen.getByRole("button", { name: /cancel payout/i })).toBeEnabled();
  });

  it("explains a payout that was cancelled with no refund involved", () => {
    render(<Harness api={fakeApi()} initial={payment({ status: "REVERSED", payoutItemStatus: "RETURNED" })} />);
    expect(screen.getByText(/Payout cancelled\. The money is back in your account/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});