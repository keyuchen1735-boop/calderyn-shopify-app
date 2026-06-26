import { useState, useEffect, useMemo, type ReactNode } from "react";
import { Card, Btn, Placeholder } from "../ui";
import { calibrationBand } from "../../../lib/calibration/bands";
import type { DashboardCtx } from "../context";
import type { TraceEventVM } from "../../../lib/calibration/live-engine-types";
import AutopilotHero from "../hero/AutopilotHero";
import CalderynLog from "../overview/CalderynLog";
import AutopilotFeatures from "../overview/AutopilotFeatures";
import InspectorPanel from "../overview/InspectorPanel";
import { buildFeatureGroups, countEnabled, countTotal, flaggedGroups } from "../overview/features-model";

function ScreenHeader({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
        {sub && <p className="cd-sub">{sub}</p>}
      </div>
      {children && <div className="flex items-center gap-2.5">{children}</div>}
    </header>
  );
}

export default function Dashboard({ app }: { app: DashboardCtx }) {
  const data = app.liveEngine;
  const [selected, setSelected] = useState<TraceEventVM | null>(null);

  // Time-of-day greeting resolves the local hour POST-MOUNT only (SSR renders
  // "Welcome back") to avoid a UTC-vs-local hydration mismatch.
  const [clientHour, setClientHour] = useState<number | null>(null);
  useEffect(() => setClientHour(new Date().getHours()), []);
  const greet =
    clientHour === null
      ? "Welcome back"
      : clientHour < 12
        ? "Good morning"
        : clientHour < 17
          ? "Good afternoon"
          : "Good evening";

  // Gentle live poll: refresh only the Live Engine bundle while the tab is
  // visible and no inspector row is open (mirrors the Live Engine screen).
  const refreshLiveEngine = app.refreshLiveEngine;
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !selectedId) refreshLiveEngine();
    }, 45000);
    return () => clearInterval(id);
  }, [selectedId, refreshLiveEngine]);

  // A selected row may disappear after a refresh (e.g. it scrolled out of the
  // capped trace) — fall back to the features rail rather than a stale inspector.
  useEffect(() => {
    if (selected && data && !data.trace.some((t) => t.id === selected.id)) setSelected(null);
  }, [data, selected]);

  const groups = data ? buildFeatureGroups(data.features, app.actionQueue) : [];
  const featureOn = countEnabled(groups);
  const featureTotal = countTotal(groups);
  const band = calibrationBand(data?.calibrationPct ?? null);
  const running = !!data && data.autopilotEnabled && featureOn > 0;
  // Stable Set identity across renders so the hero's setFlags effect only fires
  // when the pending queue actually changes (not on every 45s poll tick).
  const flagged = useMemo(() => flaggedGroups(app.actionQueue), [app.actionQueue]);

  return (
    <div className="cd-screen">
      <ScreenHeader title={greet} sub="Watching ad spend and inventory · together.">
        <Btn icon="bell" small onClick={() => app.navigate("alerts")}>
          All alerts
        </Btn>
      </ScreenHeader>

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
            dark={app.t.dark}
          />

          <div className="cd-eng-cols">
            <CalderynLog
              trace={data.trace}
              pending={app.actionQueue}
              app={app}
              selectedId={selectedId}
              onSelectTrace={setSelected}
            />
            <div className="flex flex-col gap-4 min-w-0">
              {selected ? (
                <InspectorPanel t={selected} onClose={() => setSelected(null)} />
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
