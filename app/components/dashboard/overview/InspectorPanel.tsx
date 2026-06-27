import { CDIcon } from "../icons";
import { money } from "../format";
import type { InspectorVM } from "./inspector-vm";

// Renders the "why Calderyn flagged it" explainer from a normalised InspectorVM,
// so the same panel serves both a durable trace row (history) and a still-pending
// proposal (flagged, needs approval). See inspector-vm.ts for the two builders.
export default function InspectorPanel({ vm, onClose }: { vm: InspectorVM; onClose: () => void }) {
  const auto = vm.confidence != null && vm.confidence >= vm.threshold;

  return (
    <div className="cd-card" style={{ padding: 0 }} data-rail-insp>
      <div className="cd-insp-head">
        <button type="button" className="cd-insp-back" aria-label="Back" onClick={onClose}>
          <CDIcon name="chevronLeft" size={15} strokeWidth={2.2} />
        </button>
        <span className="cd-insp-tag" data-tag={vm.tag}>
          {vm.tag}
        </span>
        <span className="cd-insp-time">{vm.time}</span>
      </div>
      <div className="cd-insp-body">
        <h3 className="cd-h2" style={{ letterSpacing: "-0.012em" }}>
          {vm.title}
        </h3>

        {vm.showMoney && (
          <div className="cd-insp-money">
            <span>{vm.moneyLabel}</span>
            <b className="tabular-nums">{money(Math.abs(vm.moneyCents))}</b>
          </div>
        )}

        <div>
          <div className="cd-insp-h">WHAT IT SAW</div>
          <p className="cd-body" style={{ fontSize: "calc(13px * var(--type-scale))" }}>
            {vm.signal}
          </p>
          {vm.evidence.length > 0 && (
            <div className="cd-insp-ev">
              {vm.evidence.map((e, n) => (
                <div className="cd-insp-ev-row" key={n}>
                  <span className="cd-insp-ev-dot" />
                  <span>{e}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {vm.factors.length > 0 && vm.confidence != null && (
          <div>
            <div className="cd-insp-h">HOW IT WEIGHED THIS</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {vm.factors.map((fac) => (
                <div className="cd-insp-factor" key={fac.key}>
                  <span className="cd-insp-factor-lab">{fac.label}</span>
                  <span className="cd-insp-factor-bar">
                    <span className="cd-insp-factor-fill" style={{ width: `${fac.value}%` }} />
                  </span>
                </div>
              ))}
            </div>
            <div className="cd-insp-conf" data-auto={auto ? "1" : "0"}>
              <div className="cd-insp-conf-pct">{vm.confidence}%</div>
              <div className="cd-insp-conf-note">
                Auto-act bar is {vm.threshold}%.{" "}
                {auto
                  ? "This pair clears it, so Calderyn can run it on its own."
                  : "Below the bar, so Calderyn brings it to you until its track record grows."}
              </div>
            </div>
          </div>
        )}

        <div>
          <div className="cd-insp-h">DECISION</div>
          <span className="cd-insp-dec" data-tag={vm.tag}>
            {vm.decisionLabel}
          </span>
          <p className="cd-insp-dec-note">{vm.decisionNote}</p>
        </div>
      </div>
    </div>
  );
}
