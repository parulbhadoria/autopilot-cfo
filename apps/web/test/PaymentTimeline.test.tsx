import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PaymentTimeline } from "../src/components/PaymentTimeline";

describe("PaymentTimeline", () => {
  it("shows nothing when there are no events", () => {
    const { container } = render(<PaymentTimeline events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists events in plain English and marks the ones PayPal pushed", async () => {
    const user = userEvent.setup();
    render(
      <PaymentTimeline
        events={[
          { at: 1_700_000_000_000, type: "policy_evaluated", detail: "All policy checks passed." },
          { at: 1_700_000_001_000, type: "payout_created", detail: "PENDING" },
          { at: 1_700_000_030_000, type: "webhook:PAYMENT.PAYOUTS-ITEM.SUCCEEDED", detail: "SUCCESS" },
        ]}
      />,
    );
    await user.click(screen.getByText(/Payment timeline \(3\)/));
    expect(screen.getByText("Your rules were checked")).toBeInTheDocument();
    expect(screen.getByText("PayPal accepted the payout")).toBeInTheDocument();
    expect(screen.getByText("PayPal confirmed the payment was delivered")).toBeInTheDocument();
    expect(screen.getAllByText("from PayPal webhook")).toHaveLength(1); // only the webhook event is marked
    expect(screen.getByText(/All policy checks passed/)).toBeInTheDocument();
  });
});