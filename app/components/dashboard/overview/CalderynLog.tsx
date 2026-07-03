import { useState, type MouseEvent } from "react";
import { CDIcon } from "../icons";
import { money, ACTION_LABELS, alertDetectorLabel } from "../format";
import type { ActionKind, DashboardCtx } from "../context";
import type { QueueProposalVM } from "../view-models";
import type { TraceEventVM, TraceTag } from "../../../lib/calibration/live-engine-types";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import type { RejectReason } from "~/lib/types";
import { emitEngine } from "../engine-events";
import { foldAndDock } from "../hero/hero-motion";
import { domainForDetector } from "./features-model";

/** Quick deny reasons → real RejectReason codes (teaches the engine the same way
 *  the Action Queue's full picker does). */
const DENY_REASONS: { label: string; reason: RejectReason }[] = [
  { label: "Too risky", reason: "too_aggressive" },
  { label: "Wrong timing", reason: "wrong_timing" },
  { label: "Not enough proof", reason: "not_enough_data" },
  { label: "I handle this", reason: "i_handle_this" },
];

function tagIconName(tag: TraceTag): string {
  if (tag === "UNDONE") return "undo";
  if (tag === "BLOCKED") return "pause";
  return "check";
}

function moneyPill(t: TraceEventVM): { text: string; tone: "good" | "muted" } | null {
  if (t.tag === "BLOCKED" || t.moneyCents === 0) return null;
  if (t.tag === "AUTO") return { text: `${money(t.moneyCents)} protected`, tone: "good" };
  if (t.tag === "UNDONE") return { text: `${money(Math.abs(t.moneyCents))} reversed`, tone: "muted" };
  return { text: `${money(t.moneyCents)} protected`, tone: "good" };
}

/* ---------- pending (NEEDS YOU) row ---------- */
type PendingState = "idle" | "denying" | "confirming_mute" | "approved" | "dismissed";

function PendingRow({
  proposal,
  app,
  onResolved,
  selected,
  onSelect,
}: {
  proposal: QueueProposalVM;
  app: DashboardCtx;
  onResolved: (alertId: string) => void;
  selected: boolean;
  onSelect: () => void;
}) {
  const [state, setState] = useState<PendingState>("idle");
  const [busy, setBusy] = useState(false);
  const alert = app.alerts.find((a) => a.id === proposal.alertId);
  const detector = alertDetectorLabel(proposal.detector_id, alert?.evidence ?? {});
  const actionLabel = ACTION_LABELS[proposal.action_kind] ?? proposal.action_kind;
  const group = domainForDetector(proposal.detector_id);

  const onApprove = async (e: MouseEvent<HTMLButtonElement>) => {
    if (busy) return;
    if (!alert) {
      app.toast("Refresh to reload alerts before approving.", "warn", "critical");
      return;
    }
    const rowEl = (e.currentTarget.closest(".cd-trace-row") as HTMLElement) ?? null;
    setBusy(true);
    try {
      // Real platform execution. Only a true success runs the approve sequence (P0-1).
      const { ok, receipt } = await app.executeAction(alert, proposal.action_kind as ActionKind);
      if (!ok) return; // error toast already fired in executeAction
      setState("approved");
      app.refreshCalibration();
      if (receipt?.justGraduated) {
        app.toast(`${actionLabel} just graduated. Calderyn can run it on its own now.`, "bolt", "accent");
      }
      // Optimistic calibration nudge for instant feedback; the authoritative
      // shop-level value is reconciled by refreshCalibration/refreshLiveEngine
      // below (the ring is the shop headline, not this pair's confidence). Open
      // the reasoning panel so the destination group row exists before docking.
      emitEngine("le-calibrate", { kind: "approve" });
      emitEngine("le-openreason");
      const dispatchDock = () =>
        emitEngine("le-dock", {
          group,
          label: actionLabel,
          money: money(proposal.dollar_impact),
          moneyShort: "protected",
          icon: tagIconName("AUTO"),
        });
      if (rowEl) foldAndDock(rowEl, { group, label: actionLabel }, dispatchDock);
      else dispatchDock();
      onResolved(proposal.alertId);
      // Reconcile the log/features with real post-action data AFTER the dock
      // sequence has taken control of the hero rows, so the refresh's re-render
      // cannot fight the choreography mid-flight.
      window.setTimeout(() => app.refreshLiveEngine(), 1800);
    } finally {
      setBusy(false);
    }
  };

  // I8 interstitial: muting a shipped no-brainer 409s with the warning until
  // re-sent with confirmed=true — the row swaps to an explicit confirm step.
  const [muteWarning, setMuteWarning] = useState<string | null>(null);

  const onDeny = async (reason: RejectReason, confirmed = false) => {
    if (busy) return;
    setBusy(true);
    try {
      await client.rejectProposal({ alertId: proposal.alertId, reason, confirmed });
      setState("dismissed");
      emitEngine("le-calibrate", { kind: "deny" });
      app.refreshCalibration();
      onResolved(proposal.alertId);
    } catch (err) {
      if (err instanceof DashboardApiError && err.code === "confirm_required") {
        setMuteWarning(err.message);
        setState("confirming_mute");
        return;
      }
      const msg = err instanceof DashboardApiError ? err.message : "Could not save that.";
      app.toast(msg, "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cd-trace-row" data-tag="REVIEW" data-pending="1" data-selected={selected ? "1" : "0"} style={{ cursor: "default", flexDirection: "column", alignItems: "stretch" }}>
      <button
        type="button"
        className="cd-trace-rowmain"
        onClick={onSelect}
        title="See why Calderyn flagged this"
        style={{ display: "flex", alignItems: "flex-start", gap: 12, width: "100%", background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer" }}
      >
        <span className="cd-trace-ico">
          <CDIcon name="warn" size={15} strokeWidth={2} />
        </span>
        <span className="cd-trace-main">
          <span className="cd-trace-top">
            <span className="cd-trace-tag">NEEDS YOU</span>
            <span className="cd-trace-time">{proposal.confidence}% confident</span>
          </span>
          <span className="cd-trace-text">{proposal.title || detector}</span>
          <span className="cd-trace-money cd-trace-money--good">{money(proposal.dollar_impact)} at stake · will {actionLabel.toLowerCase()}</span>
        </span>
      </button>

      {state === "idle" && (
        <div className="cd-review-actions" style={{ marginLeft: 42 }}>
          <button type="button" className="cd-review-btn cd-review-btn--reject" disabled={busy} onClick={() => setState("denying")}>
            Deny
          </button>
          <button type="button" className="cd-review-btn cd-review-btn--accept" data-acc disabled={busy || !alert} onClick={onApprove}>
            {busy ? "Approving…" : "Approve"}
          </button>
        </div>
      )}

      {state === "denying" && (
        <div className="cd-deny-why" style={{ marginLeft: 42 }}>
          <span className="cd-deny-why-lab">Why are you turning this down?</span>
          <span className="cd-deny-chips">
            {DENY_REASONS.map((r) => (
              <button key={r.reason} type="button" className="cd-deny-chip" disabled={busy} onClick={() => onDeny(r.reason)}>
                {r.label}
              </button>
            ))}
          </span>
        </div>
      )}

      {state === "confirming_mute" && (
        <div className="cd-deny-why" style={{ marginLeft: 42 }}>
          <span className="cd-deny-why-lab">{muteWarning ?? "Take over this protection?"}</span>
          <span className="cd-deny-chips">
            <button
              type="button"
              className="cd-deny-chip"
              disabled={busy}
              onClick={() => onDeny("i_handle_this", true)}
            >
              {busy ? "Saving…" : "Yes, I'll handle it myself"}
            </button>
            <button
              type="button"
              className="cd-deny-chip"
              disabled={busy}
              onClick={() => {
                setMuteWarning(null);
                setState("denying");
              }}
            >
              Keep protecting me
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/* ---------- trace row (history) ---------- */
function TraceRow({ t, selected, onSelect }: { t: TraceEventVM; selected: boolean; onSelect: () => void }) {
  const pill = moneyPill(t);
  return (
    <button type="button" className="cd-trace-row" data-tag={t.tag} data-selected={selected ? "1" : "0"} onClick={onSelect}>
      <span className="cd-trace-ico">
        <CDIcon name={tagIconName(t.tag)} size={15} strokeWidth={2.2} />
      </span>
      <span className="cd-trace-main">
        <span className="cd-trace-top">
          <span className="cd-trace-tag">{t.tag}</span>
          <span className="cd-trace-time">{t.rel || t.time}</span>
        </span>
        <span className="cd-trace-text">{t.text}</span>
        {pill && <span className={`cd-trace-money cd-trace-money--${pill.tone === "good" ? "good" : "muted"}`}>{pill.text}</span>}
      </span>
      <span className="cd-trace-chev">
        <CDIcon name="chevronRight" size={16} strokeWidth={2} />
      </span>
    </button>
  );
}

export default function CalderynLog({
  trace,
  pending,
  app,
  selectedId,
  onSelectTrace,
  onSelectPending,
}: {
  trace: TraceEventVM[];
  pending: QueueProposalVM[];
  app: DashboardCtx;
  selectedId: string | null;
  onSelectTrace: (t: TraceEventVM) => void;
  onSelectPending: (p: QueueProposalVM) => void;
}) {
  // Hide a proposal the moment it's worked through, before the next ctx refresh.
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const livePending = pending.filter((p) => !resolved.has(p.alertId));
  const markResolved = (alertId: string) => setResolved((s) => new Set(s).add(alertId));

  return (
    <div className="cd-card" style={{ padding: 0 }}>
      <div className="cd-pad-x cd-pad-t">
        <div className="flex items-center gap-2">
          <h2 className="cd-h2">Calderyn log</h2>
        </div>
      </div>
      <div className="cd-rows cd-log-scroll" style={{ paddingBottom: 6, maxHeight: 362, overflowY: "auto" }}>
        {livePending.map((p) => (
          <PendingRow
            key={p.alertId}
            proposal={p}
            app={app}
            onResolved={markResolved}
            selected={p.alertId === selectedId}
            onSelect={() => onSelectPending(p)}
          />
        ))}
        {trace.map((t) => (
          <TraceRow key={t.id} t={t} selected={t.id === selectedId} onSelect={() => onSelectTrace(t)} />
        ))}
        {livePending.length === 0 && trace.length === 0 && (
          <div className="cd-feed-row" style={{ color: "var(--text-3)" }}>
            Nothing yet. When Calderyn acts, or you approve a suggestion, it shows up here.
          </div>
        )}
      </div>
    </div>
  );
}
