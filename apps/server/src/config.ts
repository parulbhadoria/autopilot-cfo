import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the .env at the repo root regardless of where we run from.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(here, "../../../.env") });

function required(name: string, hint = ""): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. ${hint || "Copy .env.example to .env and fill it in."}`);
  return v;
}

if ((process.env.PAYPAL_ENV ?? "sandbox") !== "sandbox") {
  throw new Error("This project is sandbox-only. Set PAYPAL_ENV=sandbox.");
}

export const config = {
  paypalBaseUrl: "https://api-m.sandbox.paypal.com",
  clientId: () => required("PAYPAL_CLIENT_ID"),
  clientSecret: () => required("PAYPAL_CLIENT_SECRET"),
  vendorEmail: () => process.env.VENDOR_EMAIL ?? "",
  webhookId: () => required("PAYPAL_WEBHOOK_ID", "Create a webhook in the PayPal dashboard and copy its ID."),
  port: () => Number(process.env.PORT ?? 3000),
  adminApiKey: () => process.env.ADMIN_API_KEY || undefined,
  hardMaxWeeklyCents: () => Math.round(Number(process.env.HARD_MAX_WEEKLY_USD ?? 5000) * 100),
};
