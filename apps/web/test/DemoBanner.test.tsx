import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DemoBanner } from "../src/components/DemoBanner";

describe("DemoBanner", () => {
  it("shows nothing outside the public demo", () => {
    expect(render(<DemoBanner demo={null} busy={false} onReset={() => {}} />).container).toBeEmptyDOMElement();
    expect(render(<DemoBanner demo={{ demoMode: false }} busy={false} onReset={() => {}} />).container).toBeEmptyDOMElement();
  });

  it("says no real money moves, how many purchases are left, and lets the visitor reset", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(<DemoBanner demo={{ demoMode: true, remaining: { purchases: 3 } }} busy={false} onReset={onReset} />);
    expect(screen.getByText(/no real money moves/i)).toBeInTheDocument();
    expect(screen.getByText(/3 more purchases this hour/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /reset my demo/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("uses the singular, and hides the count when unlimited", () => {
    const { rerender } = render(<DemoBanner demo={{ demoMode: true, remaining: { purchases: 1 } }} busy={false} onReset={() => {}} />);
    expect(screen.getByText(/1 more purchase this hour/i)).toBeInTheDocument();
    rerender(<DemoBanner demo={{ demoMode: true, remaining: { purchases: null } }} busy={false} onReset={() => {}} />);
    expect(screen.queryByText(/more purchase/i)).not.toBeInTheDocument();
  });

  it("disables the button while resetting", () => {
    render(<DemoBanner demo={{ demoMode: true }} busy onReset={() => {}} />);
    expect(screen.getByRole("button", { name: /resetting/i })).toBeDisabled();
  });
});
