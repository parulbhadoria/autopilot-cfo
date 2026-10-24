import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { createApi } from "./api";
import { MandateScreen } from "./components/MandateScreen";
import { PurchaseScreen } from "./components/PurchaseScreen";

// AG Grid is large, so the ledger loads only when its tab is opened.
const LedgerScreen = lazy(() => import("./components/LedgerScreen").then((m) => ({ default: m.LedgerScreen })));

const KEY_STORAGE = "autopilot-api-key";
type Tab = "mandate" | "purchase" | "ledger";

function readKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export default function App() {
  const [apiKey, setApiKey] = useState(readKey);
  const [online, setOnline] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("mandate");

  const api = useMemo(() => createApi({ getApiKey: () => (apiKey.trim() ? apiKey.trim() : undefined) }), [apiKey]);

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY_STORAGE, apiKey);
    } catch {
      /* storage may be unavailable; the key then lives only in memory */
    }
  }, [apiKey]);

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then(() => alive && setOnline(true))
      .catch(() => alive && setOnline(false));
    return () => {
      alive = false;
    };
  }, [api]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "mandate", label: "Mandate" },
    { id: "purchase", label: "Buy" },
    { id: "ledger", label: "Ledger" },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Autopilot CFO</h1>
          <p className="tagline">An AI buyer that pays suppliers within rules you set. The AI proposes; code decides.</p>
        </div>
        <div className="topbar-right">
          <span className={`pill ${online === null ? "" : online ? "ok" : "bad"}`}>{online === null ? "Checking..." : online ? "Server online" : "Server offline"}</span>
          <label className="keybox">
            <span>API key (if required)</span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="optional" autoComplete="off" />
          </label>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab ${tab === t.id ? "active" : ""}`}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === "mandate" && <MandateScreen api={api} />}
        {tab === "purchase" && <PurchaseScreen api={api} />}
        {tab === "ledger" && (
          <Suspense fallback={<p className="muted">Loading the ledger...</p>}>
            <LedgerScreen api={api} />
          </Suspense>
        )}
      </main>
    </div>
  );
}