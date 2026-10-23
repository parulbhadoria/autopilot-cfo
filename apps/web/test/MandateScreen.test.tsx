import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Api } from "../src/api";
import { DEMO_INSTRUCTION, MandateScreen } from "../src/components/MandateScreen";
import type { Mandate, ParsedMandate } from "../src/types";

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  mandateId: "m1",
  ownerNote: DEMO_INSTRUCTION,
  currency: "USD",
  weeklyBudgetCents: 40_000,
  perTransactionCapCents: 40_000,
  autoApproveUnderCents: 10_000,
  categories: ["flour", "butter", "sheet pans"],
  vendors: [{ vendorId: "sunrise", name: "Sunrise Mills", payeeEmail: "vendor@example.com" }],
  maxExtraChargesPct: 15,
  splitWindowHours: 24,
  ...over,
});
const parsed = (over: Partial<ParsedMandate> = {}): ParsedMandate => ({
  mandate: mandate(),
  assumptions: ["No per-purchase cap given; using the weekly budget."],
  ...over,
});

function fakeApi(over: Partial<Record<keyof Api, any>> = {}) {
  return {
    getMandate: vi.fn().mockResolvedValue({ mandate: null }),
    parseMandate: vi.fn().mockResolvedValue(parsed()),
    putMandate: vi.fn().mockImplementation(async (m: Mandate) => ({ mandate: m })),
    ...over,
  } as unknown as Api & { getMandate: any; parseMandate: any; putMandate: any };
}

describe("MandateScreen", () => {
  it("shows the active mandate on load", async () => {
    const api = fakeApi({ getMandate: vi.fn().mockResolvedValue({ mandate: mandate() }) });
    render(<MandateScreen api={api} />);
    expect(await screen.findByText("Sunrise Mills")).toBeInTheDocument();
    expect(screen.getByText("Weekly budget")).toBeInTheDocument();
    expect(screen.getAllByText("$400.00").length).toBeGreaterThan(0);
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(screen.getByText("sheet pans")).toBeInTheDocument();
  });

  it("explains when there is no mandate", async () => {
    render(<MandateScreen api={fakeApi()} />);
    expect(await screen.findByText(/No mandate yet/i)).toBeInTheDocument();
  });

  it("only enables Parse when there is enough text, and the demo button fills it in", async () => {
    const user = userEvent.setup();
    render(<MandateScreen api={fakeApi()} />);
    const parse = screen.getByRole("button", { name: /parse my rules/i });
    expect(parse).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /use demo instruction/i }));
    expect(screen.getByLabelText(/your instruction/i)).toHaveValue(DEMO_INSTRUCTION);
    expect(parse).toBeEnabled();
  });

  it("parses the text and shows an editable review with the AI's assumptions", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<MandateScreen api={api} />);
    await user.type(screen.getByLabelText(/your instruction/i), "Keep flour stocked, max $400/week");
    await user.click(screen.getByRole("button", { name: /parse my rules/i }));

    expect(api.parseMandate).toHaveBeenCalledWith("Keep flour stocked, max $400/week");
    expect(await screen.findByLabelText(/weekly budget/i)).toHaveValue("400.00");
    expect(screen.getByLabelText(/per-purchase cap/i)).toHaveValue("400.00");
    expect(screen.getByLabelText(/auto-approve under/i)).toHaveValue("100.00");
    expect(screen.getByText(/No per-purchase cap given/)).toBeInTheDocument();
    expect(screen.getByText(/had to assume/i)).toBeInTheDocument();
  });

  it("activates the mandate with the owner's edited numbers, converted to cents", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<MandateScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /use demo instruction/i }));
    await user.click(screen.getByRole("button", { name: /parse my rules/i }));

    const auto = await screen.findByLabelText(/auto-approve under/i);
    await user.clear(auto);
    await user.type(auto, "75.50");
    expect(screen.getByText(/You changed the numbers/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /confirm and activate/i }));

    await waitFor(() => expect(api.putMandate).toHaveBeenCalledTimes(1));
    expect(api.putMandate.mock.calls[0][0]).toMatchObject({
      mandateId: "m1",
      weeklyBudgetCents: 40_000,
      perTransactionCapCents: 40_000,
      autoApproveUnderCents: 7_550,
      categories: ["flour", "butter", "sheet pans"],
    });
    expect(await screen.findByText(/Mandate activated/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/weekly budget \(\$\)/i)).not.toBeInTheDocument();
    expect(screen.getByText("$75.50")).toBeInTheDocument();
  });

  it("blocks impossible numbers before they reach the server", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<MandateScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /use demo instruction/i }));
    await user.click(screen.getByRole("button", { name: /parse my rules/i }));

    const auto = await screen.findByLabelText(/auto-approve under/i);
    await user.clear(auto);
    await user.type(auto, "500");
    expect(screen.getByText(/auto-approve limit cannot be higher/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm and activate/i })).toBeDisabled();

    await user.clear(auto);
    await user.type(auto, "abc");
    expect(screen.getByText(/must be an amount/i)).toBeInTheDocument();

    const cap = screen.getByLabelText(/per-purchase cap/i);
    await user.clear(auto);
    await user.type(auto, "50");
    await user.clear(cap);
    await user.type(cap, "900");
    expect(screen.getByText(/cap cannot be higher than the weekly budget/i)).toBeInTheDocument();
    expect(api.putMandate).not.toHaveBeenCalled();
  });

  it("shows API errors from parsing and from saving", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ parseMandate: vi.fn().mockRejectedValueOnce(new ApiError(422, "None of the requested items are sold by this vendor.")).mockResolvedValue(parsed()) });
    render(<MandateScreen api={api} />);
    await user.click(screen.getByRole("button", { name: /use demo instruction/i }));
    await user.click(screen.getByRole("button", { name: /parse my rules/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("None of the requested items are sold by this vendor.");

    api.putMandate.mockRejectedValueOnce(new ApiError(400, "weeklyBudgetCents: too large"));
    await user.click(screen.getByRole("button", { name: /parse my rules/i }));
    await user.click(await screen.findByRole("button", { name: /confirm and activate/i }));
    expect(await screen.findByText("weeklyBudgetCents: too large")).toBeInTheDocument();
  });

  it("lets the owner discard a parsed draft", async () => {
    const user = userEvent.setup();
    render(<MandateScreen api={fakeApi()} />);
    await user.click(screen.getByRole("button", { name: /use demo instruction/i }));
    await user.click(screen.getByRole("button", { name: /parse my rules/i }));
    await screen.findByLabelText(/weekly budget/i);
    await user.click(screen.getByRole("button", { name: /discard/i }));
    expect(screen.queryByLabelText(/weekly budget/i)).not.toBeInTheDocument();
  });
});