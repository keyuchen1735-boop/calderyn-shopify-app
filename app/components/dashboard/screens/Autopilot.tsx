import { Fragment, useState, useEffect, useMemo } from "react";
import { Btn, Card, Placeholder, TickGauge } from "../ui";
import { hasEngineSignals } from "../first-run";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import { money } from "../format";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import type { ActionKind, RejectReason } from "~/lib/types";
import type { DashboardCtx } from "../context";
import type { WatchGroup } from "../engine-events";
import type {
  LiveEnginePageData,
  TraceEventVM,
} from "../../../lib/calibration/live-engine-types";
import type { AuditVM, QueueProposalVM } from "../view-models";
import { canOneClickAlert, oneClickKind } from "~/lib/dashboard/one-click";
import { buildFeatureGroups, countEnabled, flaggedGroups } from "../overview/features-model";
import AutopilotFeatures from "../overview/AutopilotFeatures";
import { featureLabel } from "~/lib/labels";
import { moneyVerb, reasonLines } from "./autopilot-cards";

/** Quick reject reasons → real RejectReason codes. "Doesn't fit" has no
 *  dedicated code, so it rides `other` with the label as the note. */
const REJECT_CHIPS: { label: string; reason: RejectReason; note?: string }[] = [
  { label: "Too risky", reason: "too_aggressive" },
  { label: "Wrong timing", reason: "wrong_timing" },
  { label: "Doesn't fit", reason: "other", note: "Doesn't fit my brand" },
];

/** Calibration split panel: the tick gauge on the left and the real pending
 *  queue as approve/reject teaching rows on the right. Shown only while
 *  calibration is incomplete; the feature switchboard card below carries the
 *  unlock progress and the per-feature toggles. */
function CalibrationTrainer({
  app,
  pct,
  onReview,
}: {
  app: DashboardCtx;
  pct: number;
  onReview: (p: QueueProposalVM) => void;
}) {
  const [approving, setApproving] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [note, setNote] = useState("");

  const queue = app.actionQueue;
  const ptsToGo = Math.max(0, 100 - Math.round(pct));
  // ONE teaching signal at a time, across both verbs: an in-flight approve
  // locks reject (and vice versa) so a single decision can never send the
  // calibration engine contradictory feedback.
  const teachingBusy = approving !== null || rejectBusy;

  // One-click is only offered when the client can actually run the action
  // here: a whitelisted kind, the alert loaded, and (for campaign kinds) a
  // resolvable campaign id. Everything else renders "Review" and opens the
  // alert's own detail — never a button that can't succeed, never a silent
  // default on a kind that deserves a review step (price, PO quantities).
  const canOneClick = (p: QueueProposalVM): boolean =>
    canOneClickAlert(
      app.alerts.find((a) => a.id === p.alertId),
      p.action_kind,
    );

  const approve = async (p: QueueProposalVM) => {
    if (teachingBusy) return;
    const alert = app.alerts.find((a) => a.id === p.alertId);
    if (!alert || !oneClickKind(p.action_kind) || !canOneClick(p)) {
      onReview(p);
      return;
    }
    setApproving(p.alertId);
    try {
      // Real platform execution; the error toast fires inside executeAction.
      const { ok } = await app.executeAction(alert, p.action_kind);
      if (ok) app.refresh();
    } finally {
      setApproving(null);
    }
  };

  const reject = async (p: QueueProposalVM, reason: RejectReason, noteText?: string) => {
    if (teachingBusy) return;
    setRejectBusy(true);
    try {
      await client.rejectProposal({
        alertId: p.alertId,
        reason,
        ...(noteText ? { note: noteText } : {}),
      });
      setRejecting(null);
      setNote("");
      app.toast("Feedback saved. Calderyn will factor it in.", "check");
      app.refresh();
    } catch (err) {
      const msg = err instanceof DashboardApiError ? err.message : "Could not save that.";
      app.toast(msg, "warn", "critical");
    } finally {
      setRejectBusy(false);
    }
  };

  return (
    <div className="cd-card" style={{ overflow: "hidden" }}>
      <div className="cd-calib-split">
        <div className="cd-calib-left">
          <TickGauge pct={pct} size={184} />
          <div className="cd-calib-eyebrow">
            <span className="cd-eg-live-dot" />
            Calibrating
          </div>
          <div className="cd-caption">
            <b className="tabular-nums" style={{ color: "var(--text-1)" }}>
              {ptsToGo}
            </b>{" "}
            pts to full auto
          </div>
        </div>

        <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "16px 20px 8px",
            }}
          >
            <div className="cd-anh" style={{ margin: 0 }}>
              <CDIcon name="sparkle" size={15} strokeWidth={1.9} />
              Approve to train
            </div>
            <span className="cd-caption">{queue.length} left</span>
          </div>

          <div className="cd-caption" style={{ padding: "0 20px 6px", lineHeight: 1.4 }}>
            Calderyn spotted these while watching your store. Approve the good calls to
            teach it, and soon it handles them for you.
          </div>

          {queue.map((p) => (
            <Fragment key={p.alertId}>
              <div className="cd-actcard">
                <div className="cd-actcard-hd">
                  <span className="cd-sug-ico cd-actcard-ico">
                    <CDIcon name={CD_ACTION_ICON[p.action_kind] ?? "bolt"} size={17} strokeWidth={1.8} />
                  </span>
                  <div className="cd-actcard-title">
                    {featureLabel(p.detector_id, p.action_kind as ActionKind)}
                    <div className="cd-actcard-subj">{p.title}</div>
                  </div>
                  <span className="cd-actcard-conf">
                    <b className="tabular-nums">{p.confidence}%</b> sure
                  </span>
                </div>

                {(() => {
                  const r = reasonLines(p.reasoning, p.detector_id);
                  return (
                    <div className="cd-actcard-why">
                      <span className="cd-actcard-why-cat">Why: {r.category}.</span>
                      {r.narrative ? ` ${r.narrative}` : ""}
                    </div>
                  );
                })()}

                <div className="cd-actcard-foot">
                  {p.dollar_impact !== 0 && (
                    <span className="cd-actcard-money">
                      {moneyVerb(p.action_kind)}{" "}
                      <b className="tabular-nums">~{money(p.dollar_impact)}</b>
                    </span>
                  )}
                  <div className="cd-actcard-acts">
                    <button
                      type="button"
                      className="cd-btn cd-btn-secondary cd-btn-sm"
                      aria-expanded={rejecting === p.alertId}
                      aria-controls={`cd-reject-${p.alertId}`}
                      disabled={teachingBusy}
                      onClick={() => {
                        setRejecting((cur) => (cur === p.alertId ? null : p.alertId));
                        setNote("");
                      }}
                    >
                      Not now
                    </button>
                    <Btn kind="primary" small disabled={teachingBusy} onClick={() => approve(p)}>
                      {approving === p.alertId
                        ? "Doing…"
                        : canOneClick(p)
                          ? "Do it"
                          : "Review"}
                    </Btn>
                  </div>
                </div>
              </div>
              {rejecting === p.alertId && (
                <div className="cd-reject-panel" id={`cd-reject-${p.alertId}`}>
                  <span className="cd-caption" style={{ flexShrink: 0 }}>
                    Why?
                  </span>
                  {REJECT_CHIPS.map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      className="cd-reject-chip"
                      disabled={teachingBusy}
                      onClick={() => reject(p, c.reason, c.note)}
                    >
                      {c.label}
                    </button>
                  ))}
                  <input
                    className="cd-input"
                    type="text"
                    placeholder="Other reason"
                    aria-label="Other reason"
                    value={note}
                    disabled={teachingBusy}
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && note.trim()) reject(p, "other", note.trim());
                    }}
                    style={{ flex: 1, minWidth: 130, padding: "6px 10px", fontSize: 12.5 }}
                  />
                  <Btn
                    kind="primary"
                    small
                    disabled={teachingBusy || !note.trim()}
                    onClick={() => reject(p, "other", note.trim())}
                  >
                    Send
                  </Btn>
                </div>
              )}
            </Fragment>
          ))}

          {queue.length === 0 && (
            <div className="cd-nc-empty" style={{ flex: 1 }}>
              Nothing waiting. Calderyn is scanning.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Graduated state: the Live Engine panel ---------- */

const WATCH_CELLS: { key: WatchGroup; label: string }[] = [
  { key: "inv", label: "Inventory" },
  { key: "ads", label: "Ad spend" },
  { key: "price", label: "Pricing" },
  { key: "ret", label: "Retention" },
];

/** Feed-row tone: green check for landed moves, amber for blocked, live pulse
 *  otherwise (e.g. an undone row's reversal). */
function traceTone(t: TraceEventVM): "done" | "need" | "live" {
  if (t.tag === "BLOCKED") return "need";
  if (t.moneyCents > 0 || t.tag === "APPROVED" || t.tag === "AUTO") return "done";
  return "live";
}

/** The graduated Autopilot surface: header status, the watch rail, the newest
 *  decision as the focus card, and the recent-moves feed. Every value binds to
 *  the real Live Engine bundle; nothing is simulated. */
function LiveEnginePanel({
  app,
  data,
  flagged,
}: {
  app: DashboardCtx;
  data: LiveEnginePageData;
  flagged: Set<WatchGroup>;
}) {
  // Trace ids are audit-row ids (buildLiveEnginePageData maps trace events off
  // durable audit rows 1:1), so undo eligibility comes straight from the
  // matching audit entry — same gate the Audit screen uses.
  const undoEntryFor = (traceId: string): AuditVM | null => {
    const entry = app.audit.find((a) => a.id === traceId);
    return entry && entry.undo_eligible && !entry.undo_of ? entry : null;
  };

  const newest = data.trace[0] ?? null;
  const sub = data.autopilotEnabled
    ? newest
      ? `${newest.text} · ${newest.rel}`
      : "Running — no moves yet"
    : "Autopilot is paused";

  const cells = WATCH_CELLS.map((c) => ({
    ...c,
    count: data.watchScan[c.key].length,
  })).filter((c) => c.count > 0);

  return (
    <div className="cd-engine cd-engine-in">
      <div className="cd-eg-pad">
        <div className="cd-eg-top">
          <div style={{ display: "flex", gap: 13, alignItems: "flex-start", minWidth: 0 }}>
            <span className="cd-eg-mark">
              <svg viewBox="0 0 32 32" width="22" height="22" fill="none" role="img" aria-label="Calderyn">
                <path
                  d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="cd-eg-status">Calderyn Live Engine</div>
              <div className="cd-eg-sub">{sub}</div>
            </div>
          </div>
          <div className="cd-eg-money">
            <b className="tabular-nums">{money(data.moneyProtectedWeekCents)}</b>
            <span>protected this week</span>
          </div>
        </div>

        {cells.length > 0 && (
          <div className="cd-watch">
            {cells.map((c) => (
              <div key={c.key} className="cd-wcell" data-hot={flagged.has(c.key) ? "1" : "0"}>
                <div className="cd-wcell-k">
                  {c.label}
                  <span className="cd-wdot" />
                </div>
                <div className="cd-wcell-v">{c.count} tracked</div>
              </div>
            ))}
          </div>
        )}

        {newest && (
          <div className="cd-eg-focus">
            <div className="cd-eg-focus-top">
              <span className="cd-eg-check" data-done="1">
                <CDIcon name="check" size={16} strokeWidth={2} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="cd-eg-focus-title">{newest.text}</div>
              </div>
              <span className="cd-eg-donepill">
                <CDIcon name="check" size={12} strokeWidth={2.2} />
                Done
              </span>
            </div>
            {newest.evidence.length > 0 && (
              <div className="cd-eg-facts">
                {newest.evidence.slice(0, 4).map((line, i) => (
                  <div key={`${i}:${line}`} className="cd-eg-fact">
                    <div className="cd-eg-fact-v">
                      {line}
                      <CDIcon name="check" size={14} strokeWidth={2} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {newest.moneyCents !== 0 && (
              <div className="cd-eg-focus-foot">
                <b className="tabular-nums">{money(newest.moneyCents)}</b>
                <span>impact</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="cd-eg-feed">
        <div className="cd-eg-feedhd">
          <b>Recent moves</b>
          <span>Undoable for 24–48h</span>
        </div>
        {data.trace.length === 0 && (
          <div className="cd-efrow">
            <span className="cd-eftext" style={{ color: "var(--eg-2)" }}>
              No autopilot moves yet.
            </span>
          </div>
        )}
        {data.trace.map((t) => {
          const entry = undoEntryFor(t.id);
          return (
            <div key={t.id} className="cd-efrow">
              <span className="cd-efico" data-tone={traceTone(t)}>
                <CDIcon name={CD_ACTION_ICON[t.actionKind] ?? "bolt"} size={14} strokeWidth={1.9} />
              </span>
              <span className="cd-eftext">{t.text}</span>
              {t.moneyCents !== 0 && (
                <span
                  className="cd-efimp"
                  data-k={t.tag === "BLOCKED" || t.moneyCents < 0 ? "need" : undefined}
                >
                  {money(t.moneyCents)}
                </span>
              )}
              {entry && (
                <button type="button" className="cd-efundo" onClick={() => app.undoAction(entry)}>
                  <CDIcon name="undo" size={11} strokeWidth={2.2} />
                  Undo
                </button>
              )}
              <span className="cd-eftime">{t.rel}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Autopilot — the trust ladder surface: the calibration trainer while the store
// is still teaching Calderyn, then the Live Engine panel once graduated.
export default function Autopilot({ app }: { app: DashboardCtx }) {
  const data = app.liveEngine;

  const refreshLiveEngine = app.refreshLiveEngine;
  // Gentle live poll: refresh only the Live Engine bundle while the tab is visible.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refreshLiveEngine();
    }, 45000);
    return () => clearInterval(id);
  }, [refreshLiveEngine]);

  const flagged = useMemo(() => flaggedGroups(app.actionQueue), [app.actionQueue]);
  const featureGroups = useMemo(() => (data ? buildFeatureGroups(data.features) : []), [data]);
  // One count for the whole screen: the header pill and the switchboard badge
  // both read the deduped model, so they can never disagree.
  const running = !!data && data.autopilotEnabled && countEnabled(featureGroups) > 0;
  const pct = data?.calibrationPct ?? null;
  // A store the engine has never seen anything from has no meaningful
  // calibration score yet; showing one would be noise. Gated on data being
  // loaded so a transient in-flight refresh can't flip the screen.
  const standingBy = !!data && !app.loading && !hasEngineSignals(app);

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Autopilot">
        <div>
          <h1 className="cd-h1">Autopilot</h1>
        </div>
        <span className="cd-live-pill" data-on={running ? "1" : "0"}>
          <span className={"cd-live-dot" + (running ? " on" : "")} />
          {standingBy ? "Standing by" : pct === null ? "Calibrating" : pct >= 100 ? "Live" : `${Math.round(pct)}% calibrated`}
        </span>
      </header>

      {standingBy ? (
        <Card>
          <Placeholder
            icon="bolt"
            title="Autopilot is standing by"
            sub="It trains on your store's real orders and campaigns. Add products or connect an ad account, and calibration starts on its own."
          />
        </Card>
      ) : data ? (
        <>
          {data.calibrationPct !== null && data.calibrationPct < 100 ? (
            <CalibrationTrainer
              app={app}
              pct={data.calibrationPct}
              // Non-one-click proposals review on the alert's own detail — that's
              // where the real fix buttons (price, PO, snooze) live.
              onReview={(p) => app.navigate("alerts", p.alertId)}
            />
          ) : (
            <LiveEnginePanel app={app} data={data} flagged={flagged} />
          )}
          <AutopilotFeatures groups={featureGroups} app={app} />
        </>
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
