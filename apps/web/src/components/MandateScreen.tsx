import { useEffect, useState } from "react";
import { ApiError, type Api } from "../api";
import { dollarsInput, parseDollars, usd } from "../lib/format";
import type { Mandate, ParsedMandate } from "../types";

export const DEMO_INSTRUCTION = "Keep flour, butter and sheet pans stocked, max $400/week, auto-approve under $100, ask me for the rest.";

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong.");

function MandateSummary({ m }: { m: Mandate }) {
  return (
    <div>
      <div className="stats">
        <div className="stat">
          <span className="stat-label">Weekly budget</span>
          <span className="stat-value">{usd(m.weeklyBudgetCents)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Per-purchase cap</span>
          <span className="stat-value">{usd(m.perTransactionCapCents)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Auto-approve under</span>
          <span className="stat-value">{usd(m.autoApproveUnderCents)}</span>
        </div>
      </div>
      <p className="label-row">May buy</p>
      <div className="chips">
        {m.categories.map((c) => (
          <span key={c} className="chip">
            {c}
          </span>
        ))}
      </div>
      <p className="label-row">Allowed vendors</p>
      {m.vendors.length === 0 ? (
        <p className="muted">None. Nothing can be paid until a vendor is allowed.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Pays out to</th>
            </tr>
          </thead>
          <tbody>
            {m.vendors.map((v) => (
              <tr key={v.vendorId}>
                <td>{v.name}</td>
                <td>{v.payeeEmail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        Also enforced: shipping and fees at most {m.maxExtraChargesPct}% of the item price, and repeat orders to one vendor are checked over {m.splitWindowHours} hours.
      </p>
    </div>
  );
}

export function MandateScreen({ api }: { api: Api }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState<Mandate | null>(null);
  const [loadingActive, setLoadingActive] = useState(true);
  const [parsed, setParsed] = useState<ParsedMandate | null>(null);
  const [weekly, setWeekly] = useState("");
  const [cap, setCap] = useState("");
  const [auto, setAuto] = useState("");
  const [busy, setBusy] = useState<"parsing" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getMandate()
      .then((r) => alive && setActive(r.mandate))
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoadingActive(false));
    return () => {
      alive = false;
    };
  }, [api]);

  async function onParse() {
    setError(null);
    setNotice(null);
    setBusy("parsing");
    try {
      const result = await api.parseMandate(text);
      setParsed(result);
      setWeekly(dollarsInput(result.mandate.weeklyBudgetCents));
      setCap(dollarsInput(result.mandate.perTransactionCapCents));
      setAuto(dollarsInput(result.mandate.autoApproveUnderCents));
    } catch (e) {
      setParsed(null);
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const weeklyC = parseDollars(weekly);
  const capC = parseDollars(cap);
  const autoC = parseDollars(auto);
  const problems: string[] = [];
  if (weeklyC === null) problems.push("Weekly budget must be an amount like 400 or 400.00.");
  if (capC === null) problems.push("Per-purchase cap must be an amount like 400 or 400.00.");
  if (autoC === null) problems.push("Auto-approve limit must be an amount like 100 or 100.00.");
  if (weeklyC !== null && capC !== null && capC > weeklyC) problems.push("The per-purchase cap cannot be higher than the weekly budget.");
  if (capC !== null && autoC !== null && autoC > capC) problems.push("The auto-approve limit cannot be higher than the per-purchase cap.");

  async function onConfirm() {
    if (!parsed || problems.length > 0 || weeklyC === null || capC === null || autoC === null) return;
    setError(null);
    setBusy("saving");
    try {
      const mandate: Mandate = { ...parsed.mandate, weeklyBudgetCents: weeklyC, perTransactionCapCents: capC, autoApproveUnderCents: autoC };
      const saved = await api.putMandate(mandate);
      setActive(saved.mandate);
      setParsed(null);
      setNotice("Mandate activated. The agent can now buy within these limits.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const edited =
    parsed !== null &&
    (weeklyC !== parsed.mandate.weeklyBudgetCents || capC !== parsed.mandate.perTransactionCapCents || autoC !== parsed.mandate.autoApproveUnderCents);

  return (
    <div className="stack">
      <section className="card">
        <h2>1. Tell the agent your rules</h2>
        <p className="muted">Write it the way you would tell an employee. The AI turns it into numbers; the limits are then enforced by code, not by the AI.</p>
        <label htmlFor="instruction" className="label-row">
          Your instruction
        </label>
        <textarea
          id="instruction"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Keep flour and butter stocked, max $400/week, auto-approve under $50, ask me for the rest."
        />
        <div className="row">
          <button type="button" className="btn primary" onClick={onParse} disabled={busy !== null || text.trim().length < 5}>
            {busy === "parsing" ? "Reading your rules..." : "Parse my rules"}
          </button>
          <button type="button" className="btn" onClick={() => setText(DEMO_INSTRUCTION)} disabled={busy !== null}>
            Use demo instruction
          </button>
        </div>
      </section>

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="alert ok" role="status">
          {notice}
        </div>
      )}

      {parsed && (
        <section className="card" aria-label="Review parsed rules">
          <h2>2. Review before you activate</h2>
          <p className="muted">Check the numbers. You can edit them. Nothing is active until you confirm.</p>
          <div className="fields">
            <div>
              <label htmlFor="weekly">Weekly budget ($)</label>
              <input id="weekly" inputMode="decimal" value={weekly} onChange={(e) => setWeekly(e.target.value)} />
            </div>
            <div>
              <label htmlFor="cap">Per-purchase cap ($)</label>
              <input id="cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
            </div>
            <div>
              <label htmlFor="auto">Auto-approve under ($)</label>
              <input id="auto" inputMode="decimal" value={auto} onChange={(e) => setAuto(e.target.value)} />
            </div>
          </div>
          {edited && <p className="muted small">You changed the numbers from what the AI read.</p>}

          <p className="label-row">May buy</p>
          <div className="chips">
            {parsed.mandate.categories.map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
          </div>

          {parsed.assumptions.length > 0 && (
            <div className="alert warn">
              <strong>The AI had to assume:</strong>
              <ul>
                {parsed.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {problems.length > 0 && (
            <div className="alert error" role="alert">
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="row">
            <button type="button" className="btn primary" onClick={onConfirm} disabled={busy !== null || problems.length > 0}>
              {busy === "saving" ? "Activating..." : "Confirm and activate"}
            </button>
            <button type="button" className="btn" onClick={() => setParsed(null)} disabled={busy !== null}>
              Discard
            </button>
          </div>
        </section>
      )}

      <section className="card" aria-label="Active mandate">
        <h2>Active mandate</h2>
        {loadingActive ? (
          <p className="muted">Loading...</p>
        ) : active ? (
          <>
            <MandateSummary m={active} />
            {active.ownerNote && <p className="quote">"{active.ownerNote}"</p>}
            <details>
              <summary>Technical view (JSON)</summary>
              <pre>{JSON.stringify(active, null, 2)}</pre>
            </details>
          </>
        ) : (
          <p className="muted">No mandate yet. The agent cannot spend anything until you set one above.</p>
        )}
      </section>
    </div>
  );
}