import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { createApi } from "./api";
import { DemoBanner } from "./components/DemoBanner";
import { MandateScreen } from "./components/MandateScreen";
import { PurchaseScreen } from "./components/PurchaseScreen";
import { getSessionId } from "./lib/session";
import type { DemoInfo } from "./types";

// AG Grid is large, so the ledger loads only when its tab is opened.
const LedgerScreen = lazy(() => import("./components/LedgerScreen").then((m) => ({ default: m.LedgerScreen })));

const KEY_STORAGE = "autopilot-api-key";
type Tab = "mandate" | "purchase" | "ledger";
type Status = "checking" | "waking" | "online" | "offline";

function readKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

const PILL: Record<Status, { text: string; cls: string }> = {
  checking: { text: "Checking...", cls: "" },
  waking: { text: "Waking up the server (free hosting can take up to a minute)...", cls: "" },
  online: { text: "Server online", cls: "ok" },
  offline: { text: "Server offline", cls: "bad" },
};

export default function App({ healthRetryMs = 3000, healthTries = 30 }: { healthRetryMs?: number; healthTries?: number } = {}) {
  const [apiKey, setApiKey] = useState(readKey);
  const [status, setStatus] = useState<Status>("checking");
  const [tab, setTab] = useState<Tab>("mandate");
  const [demo, setDemo] = useState<DemoInfo | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const sessionId = useMemo(() => getSessionId(), []);

  const api = useMemo(
    () => createApi({ getApiKey: () => (apiKey.trim() ? apiKey.trim() : undefined), getSessionId: () => sessionId }),
    [apiKey, sessionId],
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY_STORAGE, apiKey);
    } catch {
      /* storage may be unavailable; the key then lives only in memory */
    }
  }, [apiKey]);

  // A free-tier server sleeps when idle and takes a while to wake, so keep trying before giving up.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const attempt = () => {
      api
        .health()
        .then(() => alive && setStatus("online"))
        .catch(() => {
          if (!alive) return;
          tries += 1;
          if (tries >= healthTries) return setStatus("offline");
          setStatus("waking");
          timer = setTimeout(attempt, healthRetryMs);
        });
    };
    attempt();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, healthRetryMs, healthTries]);

  // Ask about the public demo (limits left) once online, and again when the visitor changes tab or resets.
  useEffect(() => {
    if (status !== "online") return;
    let alive = true;
    api
      .demoInfo()
      .then((d) => alive && setDemo(d))
      .catch(() => alive && setDemo(null));
    return () => {
      alive = false;
    };
  }, [api, status, tab, resetKey]);

  async function onReset() {
    setResetting(true);
    try {
      await api.resetDemo();
      setResetKey((k) => k + 1); // remounts the screens so they reload their (now empty) data
    } finally {
      setResetting(false);
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "mandate", label: "Mandate" },
    { id: "purchase", label: "Buy" },
    { id: "ledger", label: "Ledger" },
  ];
  const pill = PILL[status];

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Autopilot CFO</h1>
          <p className="tagline">An AI buyer that pays suppliers within rules you set. The AI proposes; code decides.</p>
        </div>
        <div className="topbar-right">
          <span className={`pill ${pill.cls}`}>{pill.text}</span>
          <label className="keybox">
            <span>API key (if required)</span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="optional" autoComplete="off" />
          </label>
        </div>
      </header>

      <DemoBanner demo={demo} busy={resetting} onReset={onReset} />

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

      <main key={resetKey}>
        {tab === "mandate" && <MandateScreen api={api} demoMode={demo?.demoMode === true} />}
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
