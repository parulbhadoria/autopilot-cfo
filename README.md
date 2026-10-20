# Autopilot CFO

AI purchasing agent for micro-businesses that pays vendors through PayPal inside spending rules the owner sets
in plain English. **The model proposes; a code-level policy engine decides whether money can move.**

## Week 1 status (Days 1-7)

| Day | Piece | Where |
|---|---|---|
| 1 | PayPal sandbox hello-world (token, order, capture, payout) | `apps/server/src/scripts/01-04*` |
| 2-3 | Policy engine: schema + 15 checks incl. attack checks, 24 unit tests | `packages/guardrail` |
| 4 | Mandate parser (plain English -> validated JSON via LLM) | `apps/server/src/mandate` |
| 5 | Payment module: policy gate -> idempotent PayPal Payout, approval flow | `apps/server/src/payments` |
| 6 | Webhook receiver with PayPal signature verification | `apps/server/src/webhooks`, `paypal/webhook.ts` |
| 7 | Vertical slice demo + REST API | `src/scripts/06-demo-slice.ts`, `src/app.ts` |

## Setup

```bash
cp .env.example .env     # then fill in keys (see below)
npm install
npm test                 # 57 offline tests, no keys needed
npm run typecheck
npm run demo:slice -- --dry   # full flow with a fake payout client, no keys needed
```

## Keys you must add to `.env`

| Key | Needed for | Where to get it |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | any real PayPal call | developer.paypal.com > Apps & Credentials > **Sandbox** > your app |
| `VENDOR_EMAIL` | payout demo | Sandbox > Testing Tools > Sandbox Accounts: email of a **personal** account |
| `GROQ_API_KEY` | mandate parser (Day 4), free | console.groq.com > API Keys |
| `PAYPAL_WEBHOOK_ID` | real webhooks (Day 6) | your app > Webhooks > Add webhook (needs a public URL) |
| `ADMIN_API_KEY` (optional) | protect `/api/*` | any random string you invent |

Also in the PayPal dashboard: enable **Payouts** under your app's Features.

## Commands

```bash
# Day 1: PayPal
npm run paypal:token
npm run paypal:order                       # open link, approve as sandbox personal user
npm run paypal:capture -- <ORDER_ID>
npm run paypal:payout -- you@vendor.com 5.00

# Day 4: mandate parser (needs GROQ_API_KEY)
npm run llm:ping                           # checks your LLM key + lists available models
npm run mandate:parse -- "Keep flour and butter stocked, max $400/week, auto-approve under $50"

# Day 7: vertical slice against the real sandbox
npm run demo:slice

# Server + webhooks
npm run dev                                # http://localhost:3000
npm run webhook:forged                     # in a 2nd terminal: forged webhooks must be rejected (401)
```

## REST API (header `x-api-key` required if `ADMIN_API_KEY` is set)

```
POST /api/mandate/parse     {"text": "...", "vendors":[{"vendorId","name","payeeEmail"}]}  -> draft mandate + assumptions
PUT  /api/mandate           <mandate JSON>   (owner confirms; becomes active)
POST /api/pay               {"deal": {...}, "request": {...optional}}
GET  /api/payments          GET /api/payments/:id
POST /api/payments/:id/approve | /reject
POST /webhooks/paypal       (PayPal only; signature verified)
```

## Receiving real webhooks locally

1. Expose the server: `npx cloudflared tunnel --url http://localhost:3000` (or ngrok).
2. PayPal dashboard > your app > Webhooks > Add: `https://<tunnel>/webhooks/paypal`, subscribe to all
   `Payments and payouts` events. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`.
3. Run a payout (`POST /api/pay`); the status moves PROCESSING -> SUCCESS when the webhook arrives.
   Note: the dashboard's "Webhook simulator" events are not signed like real ones and will be rejected.

## Notes

- Money is always integer cents. Sandbox only (`PAYPAL_ENV` must be `sandbox`).
- State is in memory for Week 1 (restart = fresh ledger). Persistence comes in Week 3.
- Licence: add an MIT or Apache-2.0 `LICENSE` file when you create the GitHub repo.
