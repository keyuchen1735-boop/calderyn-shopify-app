// Radar - the overnight watcher's morning queue. Moves arrive fully evidenced
// and apply with one click; nothing touches the live store without that click.
// Seeds from the screen cache for instant paint, then refetches (mandatory
// screen-cache contract: seed + write-through + WARM_TARGETS entry).
import { useCallback, useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn, Segmented, Placeholder, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  applyRadarMove,
  confirmRadarCompetitor,
  dismissRadarCompetitor,
  dismissRadarMove,
  fetchRadar,
  RADAR_KIND_LABELS,
  revertRadarMove,
  type RadarCompetitorVM,
  type RadarMoveVM,
  type RadarOverviewVM,
} from "~/lib/dashboard/radar-client";

type Tab = "moves" | "history" | "competitors";

function whenLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function SignalTile(props: { icon: string; label: string; value: string; note: string }) {
  return (
    <Card className="cd-stat">
      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "13px", fontWeight: 650 }}>
        <CDIcon name={props.icon} size={14} strokeWidth={1.9} />
        {props.label}
      </span>
      <strong className="tabular-nums" style={{ fontSize: 22, letterSpacing: "-0.02em" }}>{props.value}</strong>
      <p className="cd-caption" style={{ margin: 0 }}>{props.note}</p>
    </Card>
  );
}

export default function Radar({ app }: { app: DashboardCtx }) {
  const { toast } = app;
  const [data, setData] = useState<RadarOverviewVM | null>(() =>
    cachedScreenData<RadarOverviewVM>(SCREEN_CACHE_KEYS.radar),
  );
  const [tab, setTab] = useState<Tab>("moves");
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Two-step revert: a conflict (409 revert_conflict) arms the button; the
  // second click sends confirm=true.
  const [armedRevertId, setArmedRevertId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await fetchRadar();
      cacheScreenData(SCREEN_CACHE_KEYS.radar, fresh);
      setData(fresh);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (move: RadarMoveVM, fn: () => Promise<unknown>, doneMsg: string) => {
      setBusyId(move.id);
      try {
        await fn();
        toast(doneMsg, "check");
        await load();
      } catch (err) {
        if (err instanceof DashboardApiError && err.code === "revert_conflict") {
          setArmedRevertId(move.id);
          toast(`${err.message} Click Revert again to continue.`, "warn", "critical");
        } else {
          toast(err instanceof DashboardApiError ? err.message : "That didn't go through. Try again.", "warn", "critical");
        }
      } finally {
        setBusyId(null);
      }
    },
    [load, toast],
  );

  const runCompetitor = useCallback(
    async (competitorId: string, fn: () => Promise<unknown>, doneMsg: string) => {
      setBusyId(competitorId);
      try {
        await fn();
        toast(doneMsg, "check");
        await load();
      } catch (err) {
        toast(err instanceof DashboardApiError ? err.message : "That didn't go through. Try again.", "warn", "critical");
      } finally {
        setBusyId(null);
      }
    },
    [load, toast],
  );

  if (!data) {
    if (loadError) {
      return (
        <Placeholder
          icon="warn"
          title="Radar couldn't load"
          sub="Try again in a moment."
          actionLabel="Try again"
          onAction={() => void load()}
        />
      );
    }
    return <TableSkeleton />;
  }

  const { moves, history, signals, competitors } = data;

  return (
    <div className="cd-screen">
      <header className="cd-screen-head">
        <div>
          <h1 className="cd-h1">Radar</h1>
          <p className="cd-sub">
            Radar watches your traffic, Google results and AI assistants overnight and drafts moves you
            can apply in a click. Nothing changes on your store until you say so.
          </p>
        </div>
        <Segmented
          small
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { value: "moves", label: `Moves${moves.length > 0 ? ` (${moves.length})` : ""}` },
            {
              value: "competitors",
              label: `Competitors${competitors.suggested.length > 0 ? ` (${competitors.suggested.length})` : ""}`,
            },
            { value: "history", label: "History" },
          ]}
        />
      </header>

      <div className="cd-stat-grid">
        <SignalTile
          icon="chart"
          label="Traffic"
          value={`${signals.traffic.yesterdayViews} views`}
          note={
            signals.traffic.lastCheckedAt
              ? `vs ${signals.traffic.weeklyAverage}/day avg · checked ${whenLabel(signals.traffic.lastCheckedAt)}`
              : "First check runs tonight"
          }
        />
        <SignalTile
          icon="search"
          label="Google"
          value={signals.google.connected ? `${signals.google.slippingCount} pages slipping` : "Not connected"}
          note={
            signals.google.connected
              ? signals.google.lastCapturedDate
                ? `Data through ${signals.google.lastCapturedDate}`
                : "Waiting for first data"
              : "Connect Google in Store > Preferences"
          }
        />
        <SignalTile
          icon="bot"
          label="AI assistants"
          value={`${signals.aiAssistants.hitsLast7} visits`}
          note={`${signals.aiAssistants.hitsPrior7} the week before`}
        />
        <SignalTile
          icon="eye"
          label="Competitors"
          value={
            signals.competitors.watching > 0
              ? `${signals.competitors.watching} watched`
              : signals.competitors.suggested > 0
                ? `${signals.competitors.suggested} suggested`
                : "None yet"
          }
          note={
            signals.competitors.watching > 0
              ? signals.competitors.changesLast7 > 0
                ? `${signals.competitors.changesLast7} change${signals.competitors.changesLast7 === 1 ? "" : "s"} this week · last ${whenLabel(signals.competitors.lastChangeAt)}`
                : "No changes this week"
              : "Radar suggests stores weekly - confirm to watch"
          }
        />
      </div>

      {tab === "moves" &&
        (moves.length === 0 ? (
          <Placeholder
            icon="check"
            title="All clear this morning"
            sub="Radar checks your store every night: page traffic, where you show up on Google, and whether AI assistants can read you. When something needs attention, a drafted move appears here."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {moves.map((m) => (
              <Card key={m.id}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="cd-chip">{RADAR_KIND_LABELS[m.kind] ?? "Store"}</span>
                  {m.chips.map((c, i) => (
                    <span key={i} className="cd-chip">{c}</span>
                  ))}
                </div>
                <h3 style={{ margin: "8px 0 4px" }}>{m.headline}</h3>
                <p className="cd-caption">{m.rationale}</p>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  {m.reviewOnly && m.deepLink ? (
                    <>
                      <Btn kind="primary" onClick={() => {
                        // Every real deep link is a same-origin dashboard route; anything else is
                        // ignored rather than handed straight to window.location.
                        if (m.deepLink?.startsWith("/dashboard/")) window.location.href = m.deepLink;
                      }}>
                        Review
                      </Btn>
                      <Btn disabled={busyId === m.id}
                        onClick={() => void run(m, () => applyRadarMove(m.id), "Marked done.")}>
                        Mark done
                      </Btn>
                    </>
                  ) : (
                    <Btn kind="primary" disabled={busyId === m.id}
                      onClick={() => void run(m, () => applyRadarMove(m.id), "Applied. You can revert it from History.")}>
                      {busyId === m.id ? "Applying…" : "Apply"}
                    </Btn>
                  )}
                  <Btn disabled={busyId === m.id}
                    onClick={() => void run(m, () => dismissRadarMove(m.id), "Dismissed.")}>
                    Dismiss
                  </Btn>
                </div>
              </Card>
            ))}
          </div>
        ))}

      {tab === "history" &&
        (history.length === 0 ? (
          <Placeholder icon="clock" title="Nothing here yet" sub="Applied and dismissed moves will show up here." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {history.map((m) => (
              <Card key={m.id}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="cd-chip">
                    {m.reverted ? "Reverted" : m.status === "applied" ? "Applied" : m.status === "expired" ? "Expired" : "Dismissed"}
                  </span>
                  <span className="cd-caption" style={{ margin: 0 }}>
                    {whenLabel(m.appliedAt ?? m.resolvedAt ?? m.createdAt)}
                  </span>
                </div>
                <h3 style={{ margin: "8px 0 4px" }}>{m.headline}</h3>
                {m.canRevert && (
                  <Btn disabled={busyId === m.id}
                    onClick={() =>
                      void run(m, () => revertRadarMove(m.id, armedRevertId === m.id), "Reverted.")
                    }>
                    {armedRevertId === m.id ? "Revert (overwrites newer edits)" : "Revert"}
                  </Btn>
                )}
              </Card>
            ))}
          </div>
        ))}

      {tab === "competitors" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {competitors.suggested.length === 0 && competitors.watching.length === 0 && (
            <Placeholder
              icon="eye"
              title="No competitors yet"
              sub="Once your store is live, Radar searches the web weekly for stores selling similar products and lists them here. Nothing is watched until you confirm it."
            />
          )}

          {competitors.suggested.length > 0 && (
            <>
              <h3 style={{ margin: "4px 0 0" }}>Suggested</h3>
              <p className="cd-caption" style={{ margin: 0 }}>
                Found by web search - listed stores aren't affiliated with Calderyn. Confirm the ones you
                want watched; Radar checks watched stores nightly.
              </p>
              {competitors.suggested.map((c: RadarCompetitorVM) => (
                <Card key={c.id}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{c.name}</strong>
                    <span className="cd-chip">{c.host}</span>
                  </div>
                  {c.reason && <p className="cd-caption">{c.reason}</p>}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Btn kind="primary" disabled={busyId === c.id}
                      onClick={() => void runCompetitor(c.id, () => confirmRadarCompetitor(c.id), "Watching. Radar checks it nightly.")}>
                      {busyId === c.id ? "Confirming…" : "Watch this store"}
                    </Btn>
                    <Btn disabled={busyId === c.id}
                      onClick={() => void runCompetitor(c.id, () => dismissRadarCompetitor(c.id), "Dismissed.")}>
                      Dismiss
                    </Btn>
                  </div>
                </Card>
              ))}
            </>
          )}

          {competitors.watching.length > 0 && (
            <>
              <h3 style={{ margin: "4px 0 0" }}>
                Watching ({competitors.watching.length}/{competitors.watchLimit})
              </h3>
              {competitors.watching.map((c: RadarCompetitorVM) => (
                <Card key={c.id}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{c.name}</strong>
                    <span className="cd-chip">{c.host}</span>
                  </div>
                  {c.changes.length === 0 ? (
                    <p className="cd-caption">No changes spotted yet. Radar checks nightly.</p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                      {c.changes.map((ch, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span className="cd-caption" style={{ margin: 0 }}>{whenLabel(ch.day)}</span>
                          {ch.chips.map((chip, j) => (
                            <span key={j} className="cd-chip">{chip}</span>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Btn disabled={busyId === c.id}
                      onClick={() => void runCompetitor(c.id, () => dismissRadarCompetitor(c.id), "Stopped watching.")}>
                      Stop watching
                    </Btn>
                  </div>
                </Card>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
