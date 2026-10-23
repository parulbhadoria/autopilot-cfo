import { useEffect, useMemo, useState } from "react";
import { createApi } from "./api";
import { MandateScreen } from "./components/MandateScreen";

const KEY_STORAGE = "autopilot-api-key";

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
        <button type="button" className="tab active" aria-current="page">
          Mandate
        </button>
      </nav>

      <main>
        <MandateScreen api={api} />
      </main>
    </div>
  );
}