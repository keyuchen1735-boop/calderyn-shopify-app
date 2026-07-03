import { Fragment, useState, useEffect, useMemo } from "react";
import { Btn, Card, Placeholder, TickGauge } from "../ui";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import { calibrationBand } from "../../../lib/calibration/bands";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import type { RejectReason } from "~/lib/types";
import type { ActionKind, DashboardCtx } from "../context";
import type {
  LiveEngineFeatureVM,
  TraceEventVM,
} from "../../../lib/calibration/live-engine-types";
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

// Kinds that are safe to run one-click from the trainer rows: no dialog inputs
// (adjust_price shows a price, create_po_draft asks quantity/cost — those
// review steps live on the inspector, so the row routes there instead of
// silently executing with defaults). Mirrors Mission Control's to-do card.
const ONE_CLICK_KINDS: ActionKind[] = [
  "pause_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "exclude_geo",
  "reallocate_inventory",
  "discontinue_sku",
  "reallocate_spend_sku",
];

function oneClickKind(k: string): k is ActionKind {
  return (ONE_CLICK_KINDS as string[]).includes(k);
}

const CAMPAIGN_KINDS = new Set([
  "pause_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "exclude_geo",
]);

/** Quick reject reasons → real RejectReason codes. "Doesn't fit" has no
 *  dedicated code, so it rides `other` with the label as the note. */
const REJECT_CHIPS: { label: string; reason: RejectReason; note?: string }[] = [
  { label: "Too risky", reason: "too_aggressive" },
  { label: "Wrong timing", reason: "wrong_timing" },
  { label: "Doesn't fit", reason: "other", note: "Doesn't fit my brand" },
];

/** Calibration split panel: the tick gauge on the left, the real pending queue
 *  as approve/reject teaching rows on the right, and the store's unlocked
 *  feature ladder as the footer. Shown only while calibration is incomplete. */
function CalibrationTrainer({
  app,
  pct,
  features,
  onReview,
}: {
  app: DashboardCtx;
  pct: number;
  features: LiveEngineFeatureVM[];
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
  // inspector — never a button that can't succeed, never a silent default on
  // a kind that deserves a review step (price, PO quantities).
  const canOneClick = (p: QueueProposalVM): boolean => {
    if (!oneClickKind(p.action_kind)) return false;
    const alert = app.alerts.find((a) => a.id === p.alertId);
    if (!alert) return false;
    if (CAMPAIGN_KINDS.has(p.action_kind) && !alert.campaign_id) return false;
    if (p.action_kind === "exclude_geo" && !alert.region) return false;
    return true;
  };

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

          {queue.map((p) => (
            <Fragment key={p.alertId}>
              <div className="cd-sug-row" style={{ padding: "10px 20px" }}>
                <span className="cd-sug-ico">
                  <CDIcon name={CD_ACTION_ICON[p.action_kind] ?? "bolt"} size={17} strokeWidth={1.8} />
                </span>
                <div
                  className="cd-sug-title"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.title}
                </div>
                <span className="cd-sug-gain">{p.confidence}%</span>
                <span className="cd-caption" style={{ whiteSpace: "nowrap" }}>
                  confidence
                </span>
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
                  Reject
                </button>
                <Btn
                  kind="primary"
                  small
                  disabled={teachingBusy}
                  onClick={() => approve(p)}
                >
                  {approving === p.alertId
                    ? "Approving…"
                    : canOneClick(p)
                      ? "Approve"
                      : "Review"}
                </Btn>
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
              Nothing waiting — Calderyn is scanning
            </div>
          )}

          {features.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                padding: "14px 20px 18px",
                marginTop: "auto",
                borderTop: "0.5px solid var(--hairline)",
              }}
            >
              {features.map((f) => (
                <span
                  key={`${f.detectorId}:${f.actionKind}`}
                  className="cd-unlock-chip"
                  data-on={f.enabled ? "1" : "0"}
                  title={f.watching}
                >
                  {f.name}
                  {f.enabled ? (
                    <b className="tabular-nums">✓</b>
                  ) : !f.proven ? (
                    // Two-bar graduation gate: approvals first, then proven
                    // dollar outcomes — show whichever gate is still holding
                    // the unlock so "3/3" can't masquerade as complete.
                    <b className="tabular-nums">
                      {f.approvals < f.approvalsNeeded
                        ? `${f.approvals}/${f.approvalsNeeded}`
                        : `${f.outcomes}/${f.outcomesNeeded} outcomes`}
                    </b>
                  ) : null}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
          {data.calibrationPct !== null && data.calibrationPct < 100 && (
            <CalibrationTrainer
              app={app}
              pct={data.calibrationPct}
              features={data.features}
              onReview={(p) => setSelected({ kind: "pending", p })}
            />
          )}

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
