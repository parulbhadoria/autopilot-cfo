import { describeEvent } from "../lib/purchase";
import type { PaymentRecord } from "../types";

/** What has happened to a payment, oldest first. Updates that PayPal pushed to us are marked. */
export function PaymentTimeline({ events }: { events: PaymentRecord["events"] }) {
  if (events.length === 0) return null;
  return (
    <details className="timeline">
      <summary>Payment timeline ({events.length})</summary>
      <ol>
        {events.map((e, i) => {
          const d = describeEvent(e);
          return (
            <li key={`${e.at}-${i}`}>
              <span className="timeline-time">{new Date(e.at).toLocaleTimeString()}</span>
              <span>
                {d.label}
                {d.viaWebhook && <span className="badge">from PayPal webhook</span>}
                {d.detail && <span className="muted small"> · {d.detail}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}