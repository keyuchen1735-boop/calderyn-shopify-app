// Calderyn DashV2 - read-only Calibration header.
// Shows shops.calibration_pct (fetched via /dashboard/api/calibration).
// READ-ONLY: no mutation buttons. Parity with the embedded Polaris version.
import { Card, Meter } from "./ui";
import { CDIcon } from "./icons";
import type { DashboardCtx } from "./context";

function label(pct: number | null): string {
  if (pct == null) return "Calibrating";
  if (pct >= 90) return "Nearly autonomous";
  if (pct >= 50) return "Learning fast";
  return "Getting started";
}

export function CalibrationHeader({ app }: { app: DashboardCtx }) {
  const pct = app.calibration?.pct ?? null;
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="cd-feed-icon" data-tone="accent">
            <CDIcon name="target" size={16} strokeWidth={1.9} />
          </span>
          <div>
            <h2 className="cd-h2">Calderyn Calibration</h2>
            <div className="cd-caption">{label(pct)} - climbs toward 100% as you train it</div>
          </div>
        </div>
        <div className="cd-stat-num tabular-nums" style={{ fontSize: "1.5rem", fontWeight: 700 }}>
          {pct == null ? "-" : `${pct}%`}
        </div>
      </div>
      <Meter pct={pct ?? 0} tone="accent" />
    </Card>
  );
}
