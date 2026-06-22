// Action Queue v2 calibration "leveling" header — the dashboard mirror of the
// embedded CalibrationLevelHeader. Ring gauge + band + 4-level milestone track +
// "what moves the number" footer. The dashboard follows the design best-effort
// (the embedded surface is the pixel-perfect target). Styling: .cd-cal2-* in
// dashboard.css. Pure render from props; band/level/milestones come from the
// shared calibrationBand helper so both surfaces stay in lockstep.
import type { CSSProperties } from "react";
import { Card, Pill } from "./ui";
import { calibrationBand } from "~/lib/calibration/bands";

const RING_R = 45;
const RING_C = 2 * Math.PI * RING_R;

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
    <Card pad={false}>
      <div className="cd-cal2-top">
        <div className="cd-cal2-ring">
          <svg width="104" height="104" viewBox="0 0 104 104">
            <circle cx="52" cy="52" r={RING_R} fill="none" stroke="var(--gray-bg)" strokeWidth="9" />
            <circle
              className="cd-cal2-ring-fill"
              cx="52"
              cy="52"
              r={RING_R}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={RING_C}
              strokeDashoffset={ringOffset}
            />
          </svg>
          <div className="cd-cal2-ring-c">
            <span className="cd-cal2-ring-pct">
              {shown}
              <span>%</span>
            </span>
            <span className="cd-cal2-ring-cap">calibrated</span>
          </div>
        </div>

        <div className="cd-cal2-body">
          <div className="flex items-center gap-2" style={{ marginBottom: 6, flexWrap: "wrap" }}>
            <h2 className="cd-h2" style={{ margin: 0 }}>
              Your agent is <span style={{ color: "var(--accent)" }}>{band.name.toLowerCase()}</span>
            </h2>
            <Pill tone="accent">
              Level {band.level} of {band.levels}
            </Pill>
          </div>
          <p className="cd-body" style={{ color: "var(--text-2)", maxWidth: 480, margin: "0 0 12px" }}>
            {band.copy}
          </p>
          <div className="cd-cal2-track">
            <div className="cd-cal2-track-base" />
            <div className="cd-cal2-track-fill" style={{ width: `${band.trackWidthPct}%` }} />
            {band.milestones.map((m, i) => (
              <div
                key={m.label}
                className="cd-cal2-ms"
                data-reached={m.reached ? "true" : "false"}
                style={milestoneStyle(m.at, i, band.milestones.length)}
              >
                <span className="cd-cal2-dot" />
                <span className="cd-cal2-ms-label">{m.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="cd-cal2-foot">
        <span className="cd-cal2-legend">
          <span className="cd-cal2-legend-sq" style={{ background: "var(--green)" }} />
          Approve to teach it <b>&ldquo;do this for me&rdquo;</b>
        </span>
        <span className="cd-cal2-legend">
          <span className="cd-cal2-legend-sq" style={{ background: "var(--red)" }} />
          Reject to teach it <b>&ldquo;not like that&rdquo;</b>
        </span>
        {nearGraduation > 0 && (
          <span className="cd-cal2-foot-grad">
            {nearGraduation} {nearGraduation === 1 ? "pair" : "pairs"} near graduation
          </span>
        )}
      </div>
    </Card>
  );
}
