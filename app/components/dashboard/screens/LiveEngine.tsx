// Calderyn DashV2 — Live Engine screen (dashboard mirror of the embedded
// app.engine.tsx). Same data contract (LiveEnginePageData from the shared
// buildLiveEnginePageData), translated into the dashboard's cd-* primitives +
// Lucide/CDIcon. Sections: autopilot features (per-feature autonomy toggle),
// the engine pipeline ("watch Calderyn work"), the live trace ("what Calderyn
// just did") with a click-through inspector, and a calibration-mini + real
// predictions rail.
import { useEffect, useState, type ReactNode } from "react";
import { Card, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import { calibrationBand } from "../../../lib/calibration/bands";
import type { DashboardCtx } from "../context";
import type {
  LiveEngineFeatureVM,
  LiveEnginePageData,
  PipelineCallVM,
  PredictionVM,
  TraceEventVM,
  TraceTag,
} from "../../../lib/calibration/live-engine-types";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

/* ---------- header ---------- */
function ScreenHeader({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
        {sub && <p className="cd-sub">{sub}</p>}
      </div>
      {right}
    </header>
  );
}

function LivePill({ label }: { label: string }) {
  return (
    <span className="cd-live-pill" data-on="1">
      <span className="cd-live-dot on" />
      {label}
    </span>
  );
}

const TAG_LABEL: Record<TraceTag, string> = {
  AUTO: "AUTO",
  APPROVED: "APPROVED",
  UNDONE: "UNDONE",
  BLOCKED: "BLOCKED",
};

function tagIconName(tag: TraceTag): string {
  if (tag === "UNDONE") return "undo";
  if (tag === "BLOCKED") return "pause";
  return "check";
}

function featureIconName(actionKind: string): string {
  return actionKind === "increase_campaign_budget" || actionKind === "reallocate_budget" ? "trendUp" : "pause";
}

function moneyPill(t: TraceEventVM): { text: string; tone: "good" | "muted" } | null {
  if (t.tag === "BLOCKED" || t.moneyCents === 0) return null;
  if (t.tag === "AUTO") return { text: `${money(t.moneyCents)} protected`, tone: "good" };
  if (t.tag === "UNDONE") return { text: `${money(Math.abs(t.moneyCents))} reversed`, tone: "muted" };
  return { text: money(t.moneyCents), tone: "good" };
}

/* ---------- 1. autopilot features ---------- */
function FeatureRow({ f, app }: { f: LiveEngineFeatureVM; app: DashboardCtx }) {
  const [on, setOn] = useState(f.enabled);
  const [busy, setBusy] = useState(false);

  useEffect(() => setOn(f.enabled), [f.enabled]);

  const toggle = async () => {
    if (busy) return;
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      await client.toggleFeatureAutonomy({ detectorId: f.detectorId, actionKind: f.actionKind, enabled: next });
      app.refreshLiveEngine();
    } catch (err) {
      setOn(!next); // revert
      const msg = err instanceof DashboardApiError ? err.message : "Could not update this feature.";
      app.toast(msg, "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cd-le-feat" data-on={on}>
      <span className="cd-le-feat-ico">
        <CDIcon name={featureIconName(f.actionKind)} size={18} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="cd-le-feat-namerow">
          <span className="cd-le-feat-name">{f.name}</span>
          {on && (
            <span className="cd-le-feat-active">
              <span className="cd-live-dot on" />
              ACTIVE
            </span>
          )}
        </div>
        <div className="cd-le-feat-sub">
          {f.watching} &middot; {f.lastText}
        </div>
      </div>
      {on && f.moneyCents > 0 && (
        <div className="cd-le-feat-money">
          <div className="cd-le-feat-money-amt tabular-nums">{money(f.moneyCents)}</div>
          <div className="cd-le-feat-money-cap">{f.actions} in 90 days</div>
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${on ? "Turn off" : "Turn on"} autopilot for ${f.name}`}
        className="cd-le-toggle"
        data-on={on}
        disabled={busy}
        onClick={toggle}
      >
        <span className="cd-le-toggle-knob" />
      </button>
    </div>
  );
}

function AutopilotCard({ data, app }: { data: LiveEnginePageData; app: DashboardCtx }) {
  const live = data.features.filter((f) => f.enabled).length;
  const running = live > 0;
  return (
    <Card pad={false}>
      <div className="cd-le-auto-head">
        <span className="cd-le-auto-ico">
          <CDIcon name="lock" size={20} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="cd-le-auto-h2row">
            <h2 className="cd-h2" style={{ margin: 0 }}>
              {running ? "Autopilot is running" : "Autopilot"}
            </h2>
            {running ? (
              <span className="cd-le-auto-badge">
                <span className="cd-live-dot on" />
                {live} {live === 1 ? "feature live" : "features live"}
              </span>
            ) : (
              <span className="cd-le-auto-badge cd-le-auto-badge--off">No features yet</span>
            )}
          </div>
          <p className="cd-caption" style={{ color: "var(--text-3)", marginTop: 3 }}>
            {running
              ? "These graduated to run without you. Calderyn handles them on its own and logs every action below."
              : "Approve suggestions in the Action Queue to graduate your most-trusted fixes to run here on their own."}
          </p>
        </div>
        {running && (
          <div className="cd-le-auto-money">
            <div className="cd-le-auto-money-amt tabular-nums">{money(data.moneyProtectedWeekCents)}</div>
            <div className="cd-le-auto-money-cap">protected this week</div>
          </div>
        )}
      </div>
      {data.features.length === 0 ? (
        <div className="cd-le-empty">
          No features run on autopilot yet. As you approve suggestions in the{" "}
          <button type="button" className="cd-le-link" onClick={() => app.navigate("action-queue")}>
            Action Queue
          </button>
          , the ones you trust most graduate to run here on their own.
        </div>
      ) : (
        <div className="cd-le-feat-list">
          {data.features.map((f) => (
            <FeatureRow key={`${f.detectorId}:${f.actionKind}`} f={f} app={app} />
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------- 2. engine pipeline ---------- */
function PipelineGraph({ call }: { call: PipelineCallVM }) {
  return (
    <div className="cd-le-graph">
      <div className="cd-le-node cd-le-node--trigger">
        <div className="cd-le-node-head">
          <span className="cd-le-node-ico">
            <CDIcon name="warn" size={14} strokeWidth={2} />
          </span>
          <span className="cd-le-node-tag">SPOTTED</span>
        </div>
        <div className="cd-le-node-title">{call.title}</div>
        <div className="cd-le-node-ctx">{call.context}</div>
      </div>

      <span className="cd-le-arrow" aria-hidden>
        <CDIcon name="chevronRight" size={18} strokeWidth={2} />
      </span>

      <div className="cd-le-node cd-le-node--checks">
        <div className="cd-le-node-head">
          <span className="cd-le-node-ico">
            <CDIcon name="list" size={14} strokeWidth={2} />
          </span>
          <span className="cd-le-node-tag">CHECKS 3 THINGS</span>
        </div>
        <div className="cd-le-factors">
          {call.factors.map((fac) => (
            <div className="cd-le-factor" key={fac.key}>
              <span className="cd-le-factor-lab">{fac.label}</span>
              <span className="cd-le-factor-bar">
                <span className="cd-le-factor-fill" style={{ width: `${fac.value}%` }} />
              </span>
            </div>
          ))}
        </div>
      </div>

      <span className="cd-le-arrow" aria-hidden>
        <CDIcon name="chevronRight" size={18} strokeWidth={2} />
      </span>

      <div className="cd-le-node cd-le-node--gate">
        <div className="cd-le-gate-lab">SURE ENOUGH?</div>
        <div className="cd-le-gate-pct" data-auto={call.auto}>
          {call.confidence}%
        </div>
        <div className="cd-le-gate-need">needs {call.threshold}%</div>
      </div>

      <div className="cd-le-outs">
        <div className="cd-le-out cd-le-out--auto" data-lit={call.auto}>
          <span className="cd-le-out-ico">
            <CDIcon name="check" size={14} strokeWidth={2.4} />
          </span>
          <div>
            <div className="cd-le-out-t">Handle it</div>
            <div className="cd-le-out-s">on its own</div>
          </div>
        </div>
        <div className="cd-le-out cd-le-out--ask" data-lit={!call.auto}>
          <span className="cd-le-out-ico">
            <CDIcon name="list" size={14} strokeWidth={2} />
          </span>
          <div>
            <div className="cd-le-out-t">Ask you first</div>
            <div className="cd-le-out-s">you decide</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const STEPS: { name: string; desc: string; icon: string }[] = [
  { name: "Watch", desc: "Reads your ad spend, inventory and orders", icon: "eye" },
  { name: "Detect", desc: "Finds money leaks across its built-in checks", icon: "warn" },
  { name: "Score", desc: "Weighs how much it trusts each fix", icon: "gauge" },
  { name: "Decide", desc: "Acts on its own or asks you first", icon: "list" },
];

function PipelineCard({ pipeline }: { pipeline: PipelineCallVM[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (pipeline.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % pipeline.length), 4200);
    return () => clearInterval(t);
  }, [pipeline.length]);

  const idx = pipeline.length ? i % pipeline.length : 0;

  return (
    <Card>
      <div className="cd-row-between" style={{ alignItems: "flex-start" }}>
        <div>
          <h2 className="cd-h2" style={{ margin: 0 }}>
            Watch Calderyn work
          </h2>
          <p className="cd-caption" style={{ color: "var(--text-3)", marginTop: 3 }}>
            {pipeline.length
              ? "A real call moving through the engine, from what it spotted to what it decided."
              : "The path every call takes through the engine."}
          </p>
        </div>
        {pipeline.length > 0 && <LivePill label="Running now" />}
      </div>

      {pipeline.length ? (
        <>
          <PipelineGraph call={pipeline[idx]} />
          {pipeline.length > 1 && (
            <div className="cd-le-dots">
              {pipeline.map((_, n) => (
                <span key={n} className="cd-le-dot" data-on={n === idx} />
              ))}
              <span className="cd-le-dots-cap">updates live</span>
            </div>
          )}
        </>
      ) : (
        <div className="cd-le-steps">
          {STEPS.map((s, n) => (
            <div className="cd-le-step" key={s.name}>
              <span className="cd-le-step-ico">
                <CDIcon name={s.icon} size={15} strokeWidth={2} />
              </span>
              <div className="cd-le-step-name">
                {n + 1}. {s.name}
              </div>
              <div className="cd-le-step-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------- 3a. trace ---------- */
function TraceRow({ t, selected, onSelect }: { t: TraceEventVM; selected: boolean; onSelect: () => void }) {
  const pill = moneyPill(t);
  return (
    <button type="button" className="cd-le-trace-row" data-tag={t.tag} data-selected={selected} onClick={onSelect}>
      <span className="cd-le-trace-ico">
        <CDIcon name={tagIconName(t.tag)} size={14} strokeWidth={2.2} />
      </span>
      <span className="min-w-0 flex-1 flex flex-col">
        <span className="cd-le-trace-top">
          <span className="cd-le-trace-tag">{TAG_LABEL[t.tag]}</span>
          <span className="cd-le-trace-time">{t.rel || t.time}</span>
        </span>
        <span className="cd-le-trace-text">{t.text}</span>
        {pill && <span className={`cd-le-trace-money cd-le-trace-money--${pill.tone}`}>{pill.text}</span>}
      </span>
      <span className="cd-le-trace-chev">
        <CDIcon name="chevronRight" size={16} strokeWidth={2} />
      </span>
    </button>
  );
}

function TraceCard({
  trace,
  selectedId,
  onSelect,
}: {
  trace: TraceEventVM[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card pad={false}>
      <div className="cd-le-trace-head">
        <div className="cd-le-trace-title">
          <span className="cd-live-dot on" />
          <h2 className="cd-h2" style={{ margin: 0 }}>
            What Calderyn just did
          </h2>
        </div>
        <p className="cd-caption" style={{ color: "var(--text-3)", marginTop: 4, marginLeft: 17 }}>
          Newest first. Click any row to see why.
        </p>
      </div>
      {trace.length === 0 ? (
        <Placeholder
          icon="scan"
          title="Nothing yet"
          sub="When Calderyn acts on its own, or you approve a suggestion, it shows up here with the full reasoning."
        />
      ) : (
        <div className="cd-le-trace-list">
          {trace.map((t) => (
            <TraceRow key={t.id} t={t} selected={t.id === selectedId} onSelect={() => onSelect(t.id)} />
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------- 3b. inspector ---------- */
function Inspector({ t, onClose, onViewHistory }: { t: TraceEventVM; onClose: () => void; onViewHistory: () => void }) {
  const pill = moneyPill(t);
  return (
    <Card pad={false}>
      <div className="cd-le-insp-head">
        <button type="button" className="cd-le-insp-back" aria-label="Close" onClick={onClose}>
          <CDIcon name="chevronLeft" size={15} strokeWidth={2.2} />
        </button>
        <span className="cd-le-insp-tag" data-tag={t.tag}>
          {TAG_LABEL[t.tag]}
        </span>
        <span className="cd-le-insp-time">{t.time}</span>
      </div>
      <div className="cd-le-insp-body">
        <h3 className="cd-le-insp-title">{t.title}</h3>

        {pill && (
          <div className={`cd-le-insp-money cd-le-insp-money--${pill.tone}`}>
            <span>{t.tag === "AUTO" ? "Ad spend protected" : t.tag === "UNDONE" ? "Reversed" : "Impact"}</span>
            <strong className="tabular-nums">{money(Math.abs(t.moneyCents))}</strong>
          </div>
        )}

        <div className="cd-le-insp-sec">
          <div className="cd-le-insp-sec-h">WHAT IT SAW</div>
          <p className="cd-le-insp-signal">{t.signal}</p>
          {t.evidence.length > 0 && (
            <div className="cd-le-insp-ev">
              {t.evidence.map((e, n) => (
                <div className="cd-le-insp-ev-row" key={n}>
                  <span className="cd-le-insp-ev-dot" />
                  <span>{e}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {t.factors && t.confidence != null && (
          <div className="cd-le-insp-sec">
            <div className="cd-le-insp-sec-h">HOW IT WEIGHED THIS</div>
            <div className="cd-le-insp-factors">
              {t.factors.map((fac) => (
                <div className="cd-le-insp-factor" key={fac.key}>
                  <div className="cd-le-insp-factor-top">
                    <span>{fac.label}</span>
                    <span className="cd-le-insp-factor-val tabular-nums">{fac.value}%</span>
                  </div>
                  <span className="cd-le-insp-factor-bar">
                    <span className="cd-le-insp-factor-fill" style={{ width: `${fac.value}%` }} />
                  </span>
                </div>
              ))}
            </div>
            <div className="cd-le-insp-conf" data-auto={t.confidence >= t.threshold}>
              <div className="cd-le-insp-conf-pct tabular-nums">{t.confidence}%</div>
              <div className="cd-le-insp-conf-note">
                Auto-act bar is {t.threshold}%.{" "}
                {t.confidence >= t.threshold
                  ? "This pair clears it, so Calderyn can run it on its own."
                  : "Below the bar, so Calderyn brings it to you until its track record grows."}
              </div>
            </div>
          </div>
        )}

        <div className="cd-le-insp-sec">
          <div className="cd-le-insp-sec-h">DECISION</div>
          <span className="cd-le-insp-dec-label" data-tag={t.tag}>
            {t.decisionLabel}
          </span>
          <p className="cd-le-insp-dec-note">{t.decisionNote}</p>
        </div>

        <button type="button" className="cd-le-insp-cta" onClick={onViewHistory}>
          View in action history
          <CDIcon name="chevronRight" size={15} strokeWidth={2.2} />
        </button>
      </div>
    </Card>
  );
}

/* ---------- 3c. calibration mini ---------- */
function CalibrationMini({ pct, app }: { pct: number | null; app: DashboardCtx }) {
  const band = calibrationBand(pct);
  const shown = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  const R = 26;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - shown / 100);
  return (
    <Card>
      <button type="button" className="cd-le-cal-top" onClick={() => app.navigate("action-queue")}>
        <div className="cd-le-cal-ring">
          <svg width="62" height="62" viewBox="0 0 62 62">
            <circle cx="31" cy="31" r={R} fill="none" stroke="var(--gray-bg)" strokeWidth="6.5" />
            <circle
              className="cd-le-cal-ring-fill"
              cx="31"
              cy="31"
              r={R}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="6.5"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={offset}
            />
          </svg>
          <span className="cd-le-cal-ring-pct">
            {shown}
            <span>%</span>
          </span>
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="cd-le-cal-namerow">
            <span className="cd-le-cal-name">Calibration</span>
            <span className="cd-le-cal-level">
              Level {band.level} of {band.levels}
            </span>
          </div>
          <p className="cd-le-cal-copy">More trust means more features graduate to autopilot.</p>
        </div>
      </button>
      <div className="cd-le-cal-track">
        {band.milestones.map((m) => (
          <span key={m.label} className="cd-le-cal-seg" data-reached={m.reached} />
        ))}
      </div>
      <div className="cd-le-cal-labels">
        {band.milestones.map((m) => (
          <span key={m.label} data-reached={m.reached}>
            {m.label}
          </span>
        ))}
      </div>
    </Card>
  );
}

/* ---------- 3d. predictions ---------- */
function predIconName(p: PredictionVM): string {
  if (p.kind === "stockout") return "box";
  if (p.tone === "up") return "trendUp";
  return "trendDown";
}

function Predictions({ predictions }: { predictions: PredictionVM[] }) {
  return (
    <Card pad={false}>
      <div className="cd-le-pred-head">
        <div className="cd-le-pred-h2row">
          <span className="cd-le-pred-h2ico">
            <CDIcon name="scan" size={17} strokeWidth={1.9} />
          </span>
          <h2 className="cd-h2" style={{ margin: 0 }}>
            What Calderyn sees coming
          </h2>
        </div>
        <p className="cd-caption" style={{ color: "var(--text-3)", marginTop: 5 }}>
          Forecasts from the same signals, before they become problems.
        </p>
      </div>
      {predictions.length === 0 ? (
        <Placeholder
          icon="scan"
          title="Nothing flagged as coming up"
          sub="Calderyn will surface inventory running low and campaigns slipping below breakeven here as it spots them."
        />
      ) : (
        <div className="cd-le-pred-list">
          {predictions.map((p, n) => (
            <div className="cd-le-pred-row" key={n} data-tone={p.tone}>
              <span className="cd-le-pred-ico">
                <CDIcon name={predIconName(p)} size={14} strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="cd-le-pred-text">{p.text}</div>
                <div className="cd-le-pred-detail">{p.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------- main screen ---------- */
export default function LiveEngine({ app }: { app: DashboardCtx }) {
  const data = app.liveEngine;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = selectedId && data ? data.trace.find((t) => t.id === selectedId) ?? null : null;

  // Gentle live poll (mirrors the embedded 45s revalidate): refresh only the
  // Live Engine bundle while the tab is visible and no row is being inspected.
  // refreshLiveEngine is a stable useCallback, so this resets at most once.
  const refreshLiveEngine = app.refreshLiveEngine;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !selectedId) refreshLiveEngine();
    }, 45000);
    return () => clearInterval(id);
  }, [selectedId, refreshLiveEngine]);

  if (!data) {
    return (
      <div className="cd-screen">
        <ScreenHeader title="Live Engine" sub="Your autopilot features running on their own. What they are doing, and why." />
        <Card>
          <Placeholder
            icon="scan"
            title={app.loading ? "Loading the engine" : "Engine data unavailable"}
            sub={
              app.loading
                ? "Reading your autopilot features and recent actions."
                : "Could not load the Live Engine just now. Refresh to try again."
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="cd-screen">
      <ScreenHeader
        title="Live Engine"
        sub="Your autopilot features running on their own. What they are doing, and why."
        right={<LivePill label="Live" />}
      />

      <AutopilotCard data={data} app={app} />
      <PipelineCard pipeline={data.pipeline} />

      <div className="cd-le-cols">
        <TraceCard trace={data.trace} selectedId={selectedId} onSelect={setSelectedId} />
        <div className="cd-le-rail">
          {selected ? (
            <Inspector t={selected} onClose={() => setSelectedId(null)} onViewHistory={() => app.navigate("audit")} />
          ) : (
            <>
              <CalibrationMini pct={data.calibrationPct} app={app} />
              <Predictions predictions={data.predictions} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
