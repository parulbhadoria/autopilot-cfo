import { z } from "zod";

/** All money is integer cents. Floats are rejected, never rounded. */
export const Cents = z.number().int().positive().max(100_000_000);
const Currency = z.string().trim().length(3).transform((s) => s.toUpperCase());
const Email = z.string().trim().toLowerCase().email();

export const VendorSchema = z.object({
  vendorId: z.string().min(1),
  name: z.string().min(1),
  payeeEmail: Email,
});

export const MandateSchema = z
  .object({
    mandateId: z.string().min(1),
    /** The owner's original plain-English instruction (for the audit trail only; never evaluated). */
    ownerNote: z.string().optional(),
    currency: Currency,
    weeklyBudgetCents: Cents,
    perTransactionCapCents: Cents,
    /** Totals strictly below this amount may be paid without asking the owner. */
    autoApproveUnderCents: Cents,
    categories: z.array(z.string().min(1)).min(1),
    vendors: z.array(VendorSchema),
    /** Shipping + other fees may not exceed this % of the item subtotal. */
    maxExtraChargesPct: z.number().min(0).max(100).default(15),
    /** Window used to detect order splitting to the same vendor. */
    splitWindowHours: z.number().positive().default(24),
    /** Optional epoch-ms expiry for the whole mandate. */
    expiresAt: z.number().int().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.autoApproveUnderCents > m.perTransactionCapCents) {
      ctx.addIssue({ code: "custom", message: "autoApproveUnder cannot exceed perTransactionCap" });
    }
    if (m.perTransactionCapCents > m.weeklyBudgetCents) {
      ctx.addIssue({ code: "custom", message: "perTransactionCap cannot exceed weeklyBudget" });
    }
  });

export const DealSchema = z.object({
  dealId: z.string().min(1),
  negotiationId: z.string().min(1),
  vendorId: z.string().min(1),
  payeeEmail: Email,
  category: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().positive(),
  shippingCents: z.number().int().nonnegative(),
  otherFeesCents: z.number().int().nonnegative(),
  totalCents: Cents,
  currency: Currency,
  /** Epoch ms. Quotes past this time are stale. */
  expiresAt: z.number().int(),
  /** Free text from agents. The policy engine NEVER reads it. */
  notes: z.string().optional(),
});

/** What is actually about to be sent to the payment rail. */
export const PaymentRequestSchema = z.object({
  dealId: z.string().min(1),
  payeeEmail: Email,
  amountCents: Cents,
  currency: Currency,
});

export type Vendor = z.infer<typeof VendorSchema>;
export type Mandate = z.infer<typeof MandateSchema>;
export type Deal = z.infer<typeof DealSchema>;
export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;
