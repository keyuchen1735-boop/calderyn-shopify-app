import { CDIcon } from "../icons";
import { money } from "../format";
import type { TraceEventVM } from "../../../lib/calibration/live-engine-types";

export default function InspectorPanel({ t, onClose }: { t: TraceEventVM; onClose: () => void }) {
  const showMoney = t.tag !== "BLOCKED" && t.moneyCents !== 0;
  const moneyLabel = t.tag === "AUTO" ? "Ad spend protected" : t.tag === "UNDONE" ? "Reversed" : "Impact";
  const auto = t.confidence != null && t.confidence >= t.threshold;

  return (
    <div className="cd-card" style={{ padding: 0 }} data-rail-insp>
      <div className="cd-insp-head">
        <button type="button" className="cd-insp-back" aria-label="Back" onClick={onClose}>
          <CDIcon name="chevronLeft" size={15} strokeWidth={2.2} />
        </button>
        <span className="cd-insp-tag" data-tag={t.tag}>
          {t.tag}
        </span>
        <span className="cd-insp-time">{t.time}</span>
      </div>
      <div className="cd-insp-body">
        <h3 className="cd-h2" style={{ letterSpacing: "-0.012em" }}>
          {t.title}
        </h3>

        {showMoney && (
          <div className="cd-insp-money">
            <span>{moneyLabel}</span>
            <b className="tabular-nums">{money(Math.abs(t.moneyCents))}</b>
          </div>
        )}

        <div>
          <div className="cd-insp-h">WHAT IT SAW</div>
          <p className="cd-body" style={{ fontSize: "calc(13px * var(--type-scale))" }}>
            {t.signal}
          </p>
          {t.evidence.length > 0 && (
            <div className="cd-insp-ev">
              {t.evidence.map((e, n) => (
                <div className="cd-insp-ev-row" key={n}>
                  <span className="cd-insp-ev-dot" />
                  <span>{e}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {t.factors && t.confidence != null && (
          <div>
            <div className="cd-insp-h">HOW IT WEIGHED THIS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {t.factors.map((fac) => (
                <div className="cd-insp-factor" key={fac.key}>
                  <span className="cd-insp-factor-lab">{fac.label}</span>
                  <span className="cd-insp-factor-bar">
                    <span className="cd-insp-factor-fill" style={{ width: `${fac.value}%` }} />
                  </span>
                </div>
              ))}
            </div>
            <div className="cd-insp-conf" data-auto={auto ? "1" : "0"}>
              <div className="cd-insp-conf-pct">{t.confidence}%</div>
              <div className="cd-insp-conf-note">
                Auto-act bar is {t.threshold}%.{" "}
                {auto
                  ? "This pair clears it, so Calderyn can run it on its own."
                  : "Below the bar, so Calderyn brings it to you until its track record grows."}
              </div>
            </div>
          </div>
        )}

        <div>
          <div className="cd-insp-h">DECISION</div>
          <span className="cd-insp-dec" data-tag={t.tag}>
            {t.decisionLabel}
          </span>
          <p className="cd-insp-dec-note">{t.decisionNote}</p>
        </div>
      </div>
    </div>
  );
}
