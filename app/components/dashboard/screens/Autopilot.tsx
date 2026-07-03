import { useState, useEffect, useMemo } from "react";
import { Card, Placeholder } from "../ui";
import { calibrationBand } from "../../../lib/calibration/bands";
import type { DashboardCtx } from "../context";
import type { TraceEventVM } from "../../../lib/calibration/live-engine-types";
import type { QueueProposalVM } from "../view-models";
import AutopilotHero from "../hero/AutopilotHero";
import CalderynLog from "../overview/CalderynLog";
import AutopilotFeatures from "../overview/AutopilotFeatures";
import InspectorPanel from "../overview/InspectorPanel";
import {
  buildFeatureGroups,
  countEnabled,
  flaggedGroups,
  flagTextByGroup,
} from "../overview/features-model";
import {
  inspectorFromTrace,
  inspectorFromPending,
  type InspectorVM,
} from "../overview/inspector-vm";

/** Which log item the inspector rail is showing, if any. */
type Selection =
  | { kind: "trace"; t: TraceEventVM }
  | { kind: "pending"; p: QueueProposalVM };

// Autopilot — the trust ladder surface: the live engine hero (calibration ring,
// watch rail), the decision log with approve/reject teaching, per-feature
// autonomy toggles, and the inspector. Promoted from the old Overview hero to
// its own screen under /dashboard/autopilot.
export default function Autopilot({ app }: { app: DashboardCtx }) {
  const data = app.liveEngine;
  const [selected, setSelected] = useState<Selection | null>(null);

  const refreshLiveEngine = app.refreshLiveEngine;
  const selectedId = selected ? (selected.kind === "trace" ? selected.t.id : selected.p.alertId) : null;

  // Gentle live poll: refresh only the Live Engine bundle while the tab is
  // visible and no inspector row is open.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !selectedId) refreshLiveEngine();
    }, 45000);
    return () => clearInterval(id);
  }, [selectedId, refreshLiveEngine]);

  // A selected item may disappear after a refresh (trace scrolled out of the
  // capped list, or the pending proposal was worked through) — fall back to the
  // features rail rather than showing a stale inspector.
  useEffect(() => {
    if (!selected || !data) return;
    if (selected.kind === "trace" && !data.trace.some((t) => t.id === selected.t.id)) {
      setSelected(null);
    }
    if (selected.kind === "pending" && !app.actionQueue.some((p) => p.alertId === selected.p.alertId)) {
      setSelected(null);
    }
  }, [data, app.actionQueue, selected]);

  const groups = data ? buildFeatureGroups(data.features) : [];
  const featureOn = countEnabled(groups);
  // Hero meter denominator stays the store's UNLOCKED features (matches the
  // embedded hero); the locked catalog rows live in the list below, not the ring.
  const featureTotal = data?.features.length ?? 0;
  const band = calibrationBand(data?.calibrationPct ?? null);
  const running = !!data && data.autopilotEnabled && featureOn > 0;
  // Stable Set identity across renders so the hero's setFlags effect only fires
  // when the pending queue actually changes (not on every 45s poll tick).
  const flagged = useMemo(() => flaggedGroups(app.actionQueue), [app.actionQueue]);
  const watchFlags = useMemo(
    () => flagTextByGroup(app.actionQueue.map((p) => ({ detectorId: p.detector_id, title: p.title }))),
    [app.actionQueue],
  );

  // Build the inspector VM for whichever item is selected (history or pending).
  let inspectorVM: InspectorVM | null = null;
  if (selected) {
    if (selected.kind === "trace") {
      inspectorVM = inspectorFromTrace(selected.t);
    } else {
      const alert = app.alerts.find((a) => a.id === selected.p.alertId);
      const call = data?.pipeline.find(
        (c) => c.detectorId === selected.p.detector_id && c.actionKind === selected.p.action_kind,
      );
      inspectorVM = inspectorFromPending(selected.p, alert, call);
    }
  }

  const pct = data?.calibrationPct ?? null;

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Autopilot">
        <div>
          <h1 className="cd-h1">Autopilot</h1>
          <p className="cd-sub">Earned autonomy — every move capped, logged, undoable.</p>
        </div>
        <span className="cd-live-pill" data-on={running ? "1" : "0"}>
          <span className={"cd-live-dot" + (running ? " on" : "")} />
          {pct === null ? "Calibrating" : pct >= 100 ? "Live" : `${Math.round(pct)}% calibrated`}
        </span>
      </header>

      {data ? (
        <section className="flex flex-col gap-4">
          <AutopilotHero
            running={running}
            featureOn={featureOn}
            featureTotal={featureTotal}
            calibrationPct={data.calibrationPct}
            level={band.level}
            levels={band.levels}
            moneyProtectedCents={data.moneyProtectedWeekCents}
            flaggedGroups={flagged}
            watchScan={data.watchScan}
            watchFlags={watchFlags}
            dark={app.t.dark}
          />

          <div className="cd-eng-cols">
            <CalderynLog
              trace={data.trace}
              pending={app.actionQueue}
              app={app}
              selectedId={selectedId}
              onSelectTrace={(t) => setSelected({ kind: "trace", t })}
              onSelectPending={(p) => setSelected({ kind: "pending", p })}
            />
            <div className="flex flex-col gap-4 min-w-0">
              {inspectorVM ? (
                <InspectorPanel vm={inspectorVM} onClose={() => setSelected(null)} />
              ) : (
                <AutopilotFeatures groups={groups} app={app} />
              )}
            </div>
          </div>
        </section>
      ) : (
        <Card>
          <Placeholder
            icon="bolt"
            title={app.loading ? "Starting the engine" : "Engine data unavailable"}
            sub={
              app.loading
                ? "Reading your autopilot features, recent actions, and calibration."
                : "Could not load the Live Engine just now. Refresh to try again."
            }
          />
        </Card>
      )}
    </div>
  );
}
