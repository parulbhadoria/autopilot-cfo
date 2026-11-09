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
  /** How often to ask PayPal about payments still in flight. 0 turns it off. */
  reconcileSeconds: () => Number(process.env.RECONCILE_SECONDS ?? 10),
  adminApiKey: () => process.env.ADMIN_API_KEY || undefined,
  /** Public-demo safeguards. Present only when DEMO_MODE=true. A limit of 0 means "no limit". */
  demo: () => {
    if (process.env.DEMO_MODE !== "true") return undefined;
    const n = (name: string, fallback: number) => (process.env[name] !== undefined && process.env[name] !== "" ? Number(process.env[name]) : fallback);
    return {
      purchasesPerHour: n("LIMIT_PURCHASES_PER_HOUR", 10),
      purchasesPerIpPerHour: n("LIMIT_PURCHASES_PER_IP_PER_HOUR", 4),
      parsesPerHour: n("LIMIT_PARSES_PER_HOUR", 60),
      parsesPerIpPerHour: n("LIMIT_PARSES_PER_IP_PER_HOUR", 15),
    };
  },
  sessionTtlMs: () => Number(process.env.SESSION_TTL_MINUTES ?? 120) * 60_000,
  maxSessions: () => Number(process.env.MAX_SESSIONS ?? 300),
  hardMaxWeeklyCents: () => Math.round(Number(process.env.HARD_MAX_WEEKLY_USD ?? 5000) * 100),
};
