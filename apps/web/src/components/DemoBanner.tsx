import type { DemoInfo } from "../types";

/** Shown only in the public demo: says what is safe about it, how many purchases are left, and lets a visitor start over. */
export function DemoBanner({ demo, busy, onReset }: { demo: DemoInfo | null; busy: boolean; onReset: () => void }) {
  if (!demo?.demoMode) return null;
  const left = demo.remaining?.purchases;
  return (
    <div className="banner" role="note">
      <span>
        <strong>Public demo.</strong> Payments go through PayPal&apos;s sandbox, so no real money moves.
        {typeof left === "number" && ` You can run ${left} more purchase${left === 1 ? "" : "s"} this hour.`}
      </span>
      <button type="button" className="btn" onClick={onReset} disabled={busy}>
        {busy ? "Resetting..." : "Reset my demo"}
      </button>
    </div>
  );
}
