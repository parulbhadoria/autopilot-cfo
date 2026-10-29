import { AllCommunityModule, ModuleRegistry, colorSchemeVariable, themeQuartz, type ColDef, type GridApi } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Api } from "../api";
import { usd } from "../lib/format";
import { toCheckRows, toEventRows, toNegotiationRows, summarize, type CheckRow, type EventRow, type NegotiationRow } from "../lib/ledger";
import type { PurchaseRun } from "../types";

ModuleRegistry.registerModules([AllCommunityModule]);

// One theme for all three grids; it follows the page's light/dark mode.
const gridTheme = themeQuartz.withPart(colorSchemeVariable);

const money = (p: { value?: number | null }) => (p.value === undefined || p.value === null ? "" : usd(p.value));
const timeOf = (p: { value?: number | null }) => (p.value ? new Date(p.value).toLocaleTimeString() : "");

function useColorMode() {
  useEffect(() => {
    const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const apply = () => {
      document.body.dataset.agThemeMode = mq?.matches ? "dark" : "light";
    };
    apply();
    mq?.addEventListener?.("change", apply);
    return () => mq?.removeEventListener?.("change", apply);
  }, []);
}

const negotiationCols: ColDef<NegotiationRow>[] = [
  { headerName: "Time", field: "when", valueFormatter: timeOf, width: 110, sort: "desc" },
  { headerName: "Item", field: "item", width: 130 },
  { headerName: "Qty", field: "quantity", width: 80, type: "numericColumn" },
  {
    headerName: "Outcome",
    field: "outcomeText",
    flex: 1,
    minWidth: 220,
    cellClassRules: {
      "cell-ok": (p) => p.data?.tone === "ok",
      "cell-warn": (p) => p.data?.tone === "warn",
      "cell-bad": (p) => p.data?.tone === "bad",
    },
  },
  { headerName: "Opening", field: "openingCents", valueFormatter: money, width: 110, type: "numericColumn" },
  { headerName: "Final", field: "finalCents", valueFormatter: money, width: 110, type: "numericColumn" },
  { headerName: "Saved", field: "savedCents", valueFormatter: money, width: 100, type: "numericColumn" },
  { headerName: "Market median", field: "marketMedianCents", valueFormatter: money, width: 140, type: "numericColumn" },
  { headerName: "Payment", field: "paymentStatus", width: 150, valueFormatter: (p) => (p.value ? String(p.value).replace(/_/g, " ").toLowerCase() : "") },
  { headerName: "PayPal says", field: "payoutItemStatus", width: 130 },
  { headerName: "Refund", field: "refundState", width: 110 },
  { headerName: "Amount", field: "amountCents", valueFormatter: money, width: 110, type: "numericColumn" },
  { headerName: "Checks passed", valueGetter: (p) => (p.data && p.data.checksTotal ? `${p.data.checksPassed}/${p.data.checksTotal}` : ""), width: 140 },
  { headerName: "Stopped by", field: "blockedBy", width: 190 },
];

const eventCols: ColDef<EventRow>[] = [
  { headerName: "#", field: "seq", width: 70, type: "numericColumn" },
  { headerName: "Time", field: "at", valueFormatter: timeOf, width: 110 },
  { headerName: "Round", field: "round", width: 90, type: "numericColumn" },
  {
    headerName: "Who",
    field: "actor",
    width: 120,
    cellClassRules: { "cell-bad": (p) => p.value === "Guardrail", "cell-agent": (p) => p.value === "Agent" },
  },
  { headerName: "Action", field: "action", width: 150 },
  { headerName: "Per unit", field: "unitPriceCents", valueFormatter: money, width: 110, type: "numericColumn" },
  { headerName: "Order total", field: "totalCents", valueFormatter: money, width: 120, type: "numericColumn" },
  { headerName: "Reasoning / message", field: "note", flex: 1, minWidth: 260, wrapText: true, autoHeight: true, tooltipField: "note" },
];

const checkCols: ColDef<CheckRow>[] = [
  {
    headerName: "Result",
    // AG Grid draws a boolean field as a checkbox, so show the words from a text value instead.
    valueGetter: (p) => (p.data ? (p.data.passed ? "Passed" : "FAILED") : ""),
    cellDataType: "text",
    width: 110,
    cellClassRules: { "cell-ok": (p) => p.data?.passed === true, "cell-bad": (p) => p.data?.passed === false },
  },
  { headerName: "Check", field: "label", width: 230 },
  { headerName: "If it fails", field: "severity", width: 180 },
  { headerName: "Detail", field: "message", flex: 1, minWidth: 260, wrapText: true, autoHeight: true },
];

const defaultColDef: ColDef = { sortable: true, resizable: true, filter: true };
const noSort: ColDef = { sortable: false, resizable: true, filter: false };

const errorText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong.");

export function LedgerScreen({ api, pollMs = 8000 }: { api: Api; pollMs?: number }) {
  useColorMode();
  const [runs, setRuns] = useState<PurchaseRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const eventsGrid = useRef<AgGridReact<EventRow>>(null);
  const negotiationsGrid = useRef<AgGridReact<NegotiationRow>>(null);
  // The grid callbacks below read the latest selection through this ref, so they never act on a stale one.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const syncSelection = useCallback((api: GridApi<NegotiationRow>) => {
    api.forEachNode((n) => {
      if (n.data?.runId === selectedRef.current && !n.isSelected()) n.setSelected(true);
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listPurchases();
      setRuns(r.purchases);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
    // Payment statuses change when PayPal webhooks arrive, so keep the ledger fresh.
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  const rows = useMemo(() => toNegotiationRows(runs), [runs]);
  const summary = useMemo(() => summarize(rows), [rows]);

  // Select the newest negotiation by default and keep the selection valid.
  useEffect(() => {
    if (rows.length === 0) return;
    if (!selectedId || !rows.some((r) => r.runId === selectedId)) {
      setSelectedId(rows.reduce((newest, r) => (r.when > newest.when ? r : newest), rows[0]).runId);
    }
  }, [rows, selectedId]);

  useEffect(() => {
    const api = negotiationsGrid.current?.api;
    if (api) syncSelection(api);
  }, [selectedId, syncSelection]);

  const selectedRun = useMemo(() => runs.find((r) => r.runId === selectedId), [runs, selectedId]);
  const events = useMemo(() => toEventRows(selectedRun), [selectedRun]);
  const checks = useMemo(() => toCheckRows(selectedRun), [selectedRun]);

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head">
          <h2>Audit ledger</h2>
          <div className="row tight">
            <button type="button" className="btn" onClick={refresh}>
              Refresh
            </button>
            <button type="button" className="btn" onClick={() => negotiationsGrid.current?.api.exportDataAsCsv({ fileName: "negotiations.csv" })} disabled={rows.length === 0}>
              Export negotiations (CSV)
            </button>
          </div>
        </div>
        <p className="muted">Every negotiation your agent has run, what it cost, and what your rules decided. Click a row to see each step and each check.</p>

        <div className="stats">
          <div className="stat">
            <span className="stat-label">Negotiations</span>
            <span className="stat-value">{summary.runs}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Paid out</span>
            <span className="stat-value">{usd(summary.paidCents)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Negotiated savings</span>
            <span className="stat-value">{usd(summary.savedCents)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Returned to you</span>
            <span className="stat-value">{usd(summary.returnedCents)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Stopped by guardrails</span>
            <span className="stat-value">{summary.blocked}</span>
          </div>
        </div>

        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {loading ? (
          <p className="muted">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="muted">No negotiations yet. Run a purchase on the Buy tab and it will appear here.</p>
        ) : (
          <div className="grid-wrap tall" role="region" aria-label="Negotiations">
            <AgGridReact<NegotiationRow>
              ref={negotiationsGrid}
              theme={gridTheme}
              rowData={rows}
              columnDefs={negotiationCols}
              defaultColDef={defaultColDef}
              getRowId={(p) => p.data.runId}
              rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
              onSelectionChanged={(e) => {
                const id = e.api.getSelectedRows()[0]?.runId;
                if (id) setSelectedId(id);
              }}
              onRowDataUpdated={(e) => syncSelection(e.api)}
              onFirstDataRendered={(e) => syncSelection(e.api)}
              suppressCellFocus
              tooltipShowDelay={400}
            />
          </div>
        )}
      </section>

      {selectedRun && (
        <>
          <section className="card" aria-label="Audit trail">
            <div className="card-head">
              <h2>Audit trail</h2>
              <button type="button" className="btn" onClick={() => eventsGrid.current?.api.exportDataAsCsv({ fileName: `audit-trail-${selectedRun.runId}.csv` })} disabled={events.length === 0}>
                Export steps (CSV)
              </button>
            </div>
            <p className="muted small">
              {selectedRun.request.quantity} x {selectedRun.request.category}. Every offer and counter, with the reasoning behind each.
            </p>
            {events.length === 0 ? (
              <p className="muted">No negotiation took place for this order.</p>
            ) : (
              <div className="grid-wrap" role="region" aria-label="Negotiation steps">
                <AgGridReact<EventRow>
                  ref={eventsGrid}
                  theme={gridTheme}
                  rowData={events}
                  columnDefs={eventCols}
                  defaultColDef={noSort}
                  getRowId={(p) => p.data.key}
                  domLayout="autoHeight"
                  suppressCellFocus
                  tooltipShowDelay={400}
                />
              </div>
            )}
          </section>

          <section className="card" aria-label="Policy checks">
            <h2>Policy checks</h2>
            <p className="muted small">The rules your agent cannot override. Any failed check that blocks the payment stops it in code.</p>
            {checks.length === 0 ? (
              <p className="muted">No payment was attempted, so no checks ran.</p>
            ) : (
              <div className="grid-wrap" role="region" aria-label="Policy check results">
                <AgGridReact<CheckRow> theme={gridTheme} rowData={checks} columnDefs={checkCols} defaultColDef={noSort} getRowId={(p) => p.data.id} domLayout="autoHeight" suppressCellFocus />
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}