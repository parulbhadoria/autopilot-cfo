# @autopilot/guardrail

Deterministic spending policy for AI agents that move money. The model proposes; this code decides.

```ts
import { MandateSchema, InMemoryLedger, evaluatePolicy } from "@autopilot/guardrail";

const result = evaluatePolicy({ mandate, deal, request, ledger });
// result.decision: "allow" | "require_approval" | "deny"
// result.checks:   every check with pass/fail + message (for your audit log)
```

Checks: schema, mandate expiry, currency, amount integrity, hidden fees, price drift, quote freshness,
vendor allowlist, payee match, category, per-transaction cap, weekly budget, replay, order splitting,
approval threshold. Money is integer cents. Malformed input is denied (fail closed).
