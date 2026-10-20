import type { IncomingHttpHeaders } from "node:http";
import { config } from "../config.js";
import { paypalFetch } from "./client.js";

export type WebhookVerifier = (headers: IncomingHttpHeaders, rawBody: string) => Promise<boolean>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Asks PayPal to verify the signature. Missing headers or bad JSON => false (fail closed). */
export const verifyWebhookSignature: WebhookVerifier = async (headers, rawBody) => {
  const needed = {
    auth_algo: one(headers["paypal-auth-algo"]),
    cert_url: one(headers["paypal-cert-url"]),
    transmission_id: one(headers["paypal-transmission-id"]),
    transmission_sig: one(headers["paypal-transmission-sig"]),
    transmission_time: one(headers["paypal-transmission-time"]),
  };
  if (Object.values(needed).some((v) => !v)) return false;

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }

  const res = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: { ...needed, webhook_id: config.webhookId(), webhook_event: event },
  });
  return res.verification_status === "SUCCESS";
};
