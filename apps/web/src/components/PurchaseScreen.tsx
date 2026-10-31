import { useEffect, useState } from "react";
import { ApiError, type Api } from "../api";
import { describeStep, effectiveOutcome, outcomeInfo } from "../lib/purchase";
import { PaymentActions } from "./PaymentActions";
import { PaymentTimeline } from "./PaymentTimeline";
import { parseDollars, usd } from "../lib/format";
import type { PaymentRecord, PurchaseRun } from "../types";

const errorText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong.");

/** Shows one purchase run: the steps, the outcome, and approve/reject when the owner must decide. */
export function RunDetail({ run, api, onChanged }: { run: PurchaseRun; api: Api; onChanged: (r: PurchaseRun) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = run.result;
  const info = outcomeInfo(effectiveOutcome(r));
  const pending = r.payment?.status === "PENDING_APPROVAL";

  async function decide(kind: "approve" | "reject") {
    if (!r.payment) return;
    setBusy(true);
    setError(null);
    try {
      const payment: PaymentRecord = kind === "approve" ? await api.approvePayment(r.payment.paymentId) : await api.rejectPayment(r.payment.paymentId);
        // The outcome shown is derived from the payment's real status, so approval that is refused on the re-check shows as blocked.
        onChanged({ ...run, result: { ...r, payment } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="run">
      <div className={`alert ${info.tone === "ok" ? "ok" : info.tone === "warn" ? "warn" : info.tone === "bad" ? "error" : ""}`}>
        <strong>{info.text}</strong>
        {r.error && <div className="small">{r.error}</div>}
      </div>

      {r.product && (
        <p className="muted small">
          {r.product.name} · list {usd(r.product.listUnitPriceCents)} · your limit {usd(r.unitLimitCents)} per unit
          {r.market && r.market.count > 0 && ` · market median ${usd(r.market.medianCents)} from ${r.market.count} listings`}
        </p>
      )}

      {r.negotiation && r.negotiation.transcript.length > 0 && (
        <ol className="steps" aria-label="Negotiation steps">
          {r.negotiation.transcript.map((e) => (
            <li key={e.seq} className={`step ${e.from}`}>
              <div className="step-head">
                <span>{describeStep(e)}</span>
                <span className="step-price">{e.totalCents !== undefined ? usd(e.totalCents) : ""}</span>
              </div>
              {(e.reasoning || e.message) && <div className="step-note">{e.reasoning || e.message}</div>}
            </li>
          ))}
        </ol>
      )}

      {r.payment && (
        <div className="payment">
          <div className="stats">
            <div className="stat">
              <span className="stat-label">Amount</span>
              <span className="stat-value">{usd(r.payment.amountCents)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Status</span>
              <span className="stat-value small">{r.payment.status.replace(/_/g, " ").toLowerCase()}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Paid to</span>
              <span className="stat-value small">{r.payment.payeeEmail}</span>
            </div>
          </div>
          <p className="small muted">{r.payment.summary}</p>
          {r.payment.checks
            .filter((c) => !c.passed && c.id !== "approval_threshold")
            .map((c) => (
              <div key={c.id} className="alert error small">
                {c.message}
              </div>
            ))}

            <PaymentActions payment={r.payment} api={api} onUpdated={(payment) => onChanged({ ...run, result: { ...r, payment } })} />   
             <PaymentTimeline events={r.payment.events} />   
          {pending && (
            <div className="row">
              <button type="button" className="btn primary" disabled={busy} onClick={() => decide("approve")}>
                {busy ? "Working..." : `Approve ${usd(r.payment.amountCents)}`}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => decide("reject")}>
                Reject
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

  /** A payment PayPal has not finished with yet, so its status can still change by itself. */
  const inFlight = (run: PurchaseRun) => ["PROCESSING", "UNKNOWN"].includes(run.result.payment?.status ?? "");

  export function PurchaseScreen({ api, pollMs = 5000 }: { api: Api; pollMs?: number }) {
  const [category, setCategory] = useState("sheet pans");
  const [quantity, setQuantity] = useState("4");
  const [maxUnit, setMaxUnit] = useState("");
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<PurchaseRun | null>(null);
  const [history, setHistory] = useState<PurchaseRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listPurchases()
      .then((r) => alive && setHistory(r.purchases))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

     // While any payment is still in flight, refresh from the server so webhooks and status checks show up by themselves.
     const live = history.some(inFlight);
     useEffect(() => {
       if (!live) return;
       let alive = true;
       const id = setInterval(async () => {
         try {
           const fresh = (await api.listPurchases()).purchases;
           if (!alive) return;
           setHistory(fresh);
           setCurrent((c) => (c ? (fresh.find((p) => p.runId === c.runId) ?? c) : c));
         } catch {
           /* a failed refresh is retried on the next tick */
         }
       }, pollMs);
       return () => {
         alive = false;
         clearInterval(id);
       };
     }, [live, api, pollMs]);

  const qty = Number(quantity);
  const qtyOk = Number.isInteger(qty) && qty >= 1 && qty <= 10_000;
  const capC = maxUnit.trim() === "" ? undefined : parseDollars(maxUnit) ?? null;
  const capOk = capC !== null;

  async function onBuy() {
    setError(null);
    setRunning(true);
    try {
      const run = await api.purchase({
        category: category.trim(),
        quantity: qty,
        ...(capC !== undefined && capC !== null ? { maxUnitPriceCents: capC } : {}),
      });
      setCurrent(run);
      setHistory((h) => [run, ...h]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  }

  function onChanged(updated: PurchaseRun) {
    setCurrent(updated);
    setHistory((h) => h.map((x) => (x.runId === updated.runId ? updated : x)));
  }

  return (
    <div className="stack">
      <section className="card">
        <h2>Buy stock</h2>
        <p className="muted">Your agent shops, negotiates within your limit, and pays only if your rules allow it.</p>
        <div className="fields">
          <div>
            <label htmlFor="category">Item</label>
            <input id="category" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div>
            <label htmlFor="qty">Quantity</label>
            <input id="qty" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div>
            <label htmlFor="maxunit">Max per unit ($, optional)</label>
            <input id="maxunit" inputMode="decimal" placeholder="chosen for you" value={maxUnit} onChange={(e) => setMaxUnit(e.target.value)} />
          </div>
        </div>
        {!qtyOk && <p className="alert error small">Quantity must be a whole number from 1 to 10,000.</p>}
        {!capOk && <p className="alert error small">Max per unit must be an amount like 25 or 25.50.</p>}
        <div className="row">
          <button type="button" className="btn primary" onClick={onBuy} disabled={running || !qtyOk || !capOk || category.trim().length === 0}>
            {running ? "Negotiating..." : "Buy now"}
          </button>
        </div>
        {running && <p className="muted small">The agent is shopping and negotiating. This can take 10 to 30 seconds.</p>}
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
      </section>

      {current && (
        <section className="card" aria-label="Latest purchase">
             <div className="card-head">
               <h2>Latest purchase</h2>
               {inFlight(current) && <span className="pill ok">Updating live</span>}
             </div>
          <RunDetail run={current} api={api} onChanged={onChanged} />
        </section>
      )}

      <section className="card" aria-label="Purchase history">
        <h2>Recent purchases</h2>
        {history.length === 0 ? (
          <p className="muted">No purchases yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Item</th>
                <th>Qty</th>
                <th>Outcome</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.runId} onClick={() => setCurrent(h)} className="clickable">
                  <td>{new Date(h.createdAt).toLocaleTimeString()}</td>
                  <td>{h.request.category}</td>
                  <td>{h.request.quantity}</td>
                  <td>{outcomeInfo(effectiveOutcome(h.result)).text.split(".")[0]}</td>
                  <td>{h.result.payment ? usd(h.result.payment.amountCents) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}