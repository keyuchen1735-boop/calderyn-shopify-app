import { CDIcon } from "../icons";
import { money } from "../format";
import type { InspectorVM } from "./inspector-vm";

// Renders the "why Calderyn flagged it" explainer from a normalised InspectorVM.
// A pending proposal leads with the plain why + key figures and frames the
// decision as the concrete outcome of approving vs. denying; a durable trace
// row (history) keeps the confidence breakdown and what-happened note. See
// inspector-vm.ts for the two builders.
export default function InspectorPanel({ vm, onClose }: { vm: InspectorVM; onClose: () => void }) {
  const auto = vm.confidence != null && vm.confidence >= vm.threshold;
  const pending = vm.variant === "pending";

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
          <div className="cd-insp-h">{pending ? "WHY CALDERYN FLAGGED THIS" : "WHAT IT SAW"}</div>
          <p className="cd-body" style={{ fontSize: "calc(13px * var(--type-scale))" }}>
            {vm.signal}
          </p>
          {pending && vm.stats.length > 0 && (
            <div className="cd-insp-stats">
              {vm.stats.map((s) => (
                <div className="cd-insp-stat" key={s.label}>
                  <span className="cd-insp-stat-lab">{s.label}</span>
                  <span className="cd-insp-stat-val tabular-nums">{s.value}</span>
                </div>
              ))}
            </div>
          )}
          {!pending && vm.evidence.length > 0 && (
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

        {!pending && vm.factors.length > 0 && vm.confidence != null && (
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

        {pending ? (
          <div className="cd-insp-decide">
            <div>
              <div className="cd-insp-h">IF YOU APPROVE</div>
              <p className="cd-insp-act-note">{vm.approveText}</p>
            </div>
            <div>
              <div className="cd-insp-h">IF YOU DENY</div>
              <p className="cd-insp-act-note">{vm.denyText}</p>
            </div>
            {vm.trustLine && <p className="cd-insp-trust">{vm.trustLine}</p>}
          </div>
        ) : (
          <div>
            <div className="cd-insp-h">DECISION</div>
            <span className="cd-insp-dec" data-tag={vm.tag}>
              {vm.decisionLabel}
            </span>
            <p className="cd-insp-dec-note">{vm.decisionNote}</p>
          </div>
        )}
      </div>
    </div>
  );
}
