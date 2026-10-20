import { z } from "zod";

/** What a buyer (rule-based or LLM) is allowed to say. Anything else is rejected by the loop. */
export const BuyerDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("offer"),
    unitPriceCents: z.number().int().positive().max(100_000_000),
    reasoning: z.string().max(2_000).default(""),
  }),
  z.object({ type: z.literal("accept"), reasoning: z.string().max(2_000).default("") }),
  z.object({ type: z.literal("walk_away"), reasoning: z.string().max(2_000).default("") }),
]);
export type BuyerDecision = z.infer<typeof BuyerDecisionSchema>;

/** One row of the negotiation audit trail (this becomes the AG Grid ledger in Week 3). */
export const TranscriptEntrySchema = z.object({
  negotiationId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.number().int(),
  round: z.number().int().nonnegative(),
  from: z.enum(["buyer", "seller"]),
  type: z.enum(["open", "offer", "counter", "accept", "reject", "walk_away", "expired"]),
  sku: z.string(),
  quantity: z.number().int().positive(),
  currency: z.string(),
  unitPriceCents: z.number().int().positive().optional(),
  shippingCents: z.number().int().nonnegative().optional(),
  totalCents: z.number().int().positive().optional(),
  expiresAt: z.number().int().optional(),
  reasoning: z.string().optional(),
  message: z.string().optional(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;