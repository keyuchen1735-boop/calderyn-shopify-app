// Action Queue v2 calibration "leveling" header (embedded). Ring gauge + band +
// 4-level milestone track + "what moves the number" footer. Pixel target:
// docs/design/calibration-ui-v2/Calderyn Action Queue v2.dc.html (calibration
// header section). Styling lives in calderyn.css (.cbx-*). Pure render from
// props; the band/level/milestones come from the shared calibrationBand helper.
import type { CSSProperties } from "react";
import { calibrationBand } from "../../lib/calibration/bands";

const RING_R = 45;
const RING_C = 2 * Math.PI * RING_R; // ~282.74

function milestoneStyle(at: number, i: number, total: number): CSSProperties {
  if (i === 0) return { left: 0, alignItems: "flex-start" };
  if (i === total - 1) return { right: 0, alignItems: "flex-end" };
  return { left: `${at}%`, transform: "translateX(-50%)", alignItems: "center" };
}

export default function CalibrationLevelHeader({
  pct,
  nearGraduation = 0,
}: {
  pct: number | null;
  nearGraduation?: number;
}) {
  const band = calibrationBand(pct);
  const shown = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  const ringOffset = RING_C * (1 - shown / 100);

  return (
    <div className="cbx-card">
      <div className="cbx-top">
        {/* ring gauge */}
        <div className="cbx-ring">
          <svg width="104" height="104" viewBox="0 0 104 104">
            <circle cx="52" cy="52" r={RING_R} fill="none" stroke="#eef0f2" strokeWidth="9" />
            <circle
              className="cbx-ring-fill"
              cx="52"
              cy="52"
              r={RING_R}
              fill="none"
              stroke="#23556e"
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={RING_C}
              strokeDashoffset={ringOffset}
            />
          </svg>
          <div className="cbx-ring-center">
            <span className="cbx-ring-pct">
              {shown}
              <span>%</span>
            </span>
            <span className="cbx-ring-cap">calibrated</span>
          </div>
        </div>

        {/* band + copy + milestone track */}
        <div className="cbx-body">
          <div className="cbx-headline">
            <h2>
              Your agent is <b>{band.name.toLowerCase()}</b>
            </h2>
            <span className="cbx-level">
              Level {band.level} of {band.levels}
            </span>
          </div>
          <p className="cbx-copy">{band.copy}</p>

          <div className="cbx-track">
            <div className="cbx-track-base" />
            <div className="cbx-track-fill" style={{ width: `${band.trackWidthPct}%` }} />
            {band.milestones.map((m, i) => (
              <div
                key={m.label}
                className="cbx-ms"
                data-reached={m.reached ? "true" : "false"}
                style={milestoneStyle(m.at, i, band.milestones.length)}
              >
                <span className="cbx-ms-dot" />
                <span className="cbx-ms-label">{m.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* what moves the number */}
      <div className="cbx-foot">
        <span className="cbx-legend">
          <span className="cbx-legend-sq cbx-legend-sq--approve" />
          Approve to teach it <b>&ldquo;do this for me&rdquo;</b>
        </span>
        <span className="cbx-legend">
          <span className="cbx-legend-sq cbx-legend-sq--reject" />
          Reject to teach it <b>&ldquo;not like that&rdquo;</b>
        </span>
        {nearGraduation > 0 && (
          <span className="cbx-foot-grad">
            {nearGraduation} {nearGraduation === 1 ? "pair" : "pairs"} near graduation
          </span>
        )}
      </div>
    </div>
  );
}
