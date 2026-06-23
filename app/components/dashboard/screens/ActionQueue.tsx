// Calderyn DashV2 — Action Queue v2 screen (dashboard mirror of the embedded
// app.queue.tsx). Leveling header + calibration-ranked proposal cards with a
// one-click Approve (confirm guard, runs the existing executeAction path) and a
// reject -> reason chips -> "what Calderyn learned" reflection receipt.
//
// Reject re-derives detector/action/impact from the TRUSTED alert server-side
// (client.rejectProposal -> /dashboard/api/queue/reject) and executes NOTHING;
// it returns the reject receipt (reflection + trust delta + savedAsRule) that
// drives the receipt card. Learned rules section + undo unchanged.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Card, Pill, Btn, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money, ACTION_LABELS, alertDetectorLabel } from "../format";
import CalibrationLevelHeader from "../CalibrationLevelHeader";
import { MIN_APPROVALS } from "~/lib/calibration/graduation";
import { actionTier } from "~/lib/calibration/confidence";
import type { ApproveReceipt } from "~/lib/calibration/delta";
import type { ActionKind, DashboardCtx } from "../context";
import type { LearnedRuleVM, QueueProposalVM } from "../view-models";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError, type RejectResult } from "~/lib/dashboard/client";
import type { RejectReason } from "~/lib/types";

/* ---------- Reject reason labels + learned-text (mirrors app.queue.tsx) ---------- */
const REJECT_REASONS: RejectReason[] = [
  "too_aggressive",
  "wrong_timing",
  "not_enough_data",
  "i_handle_this",
  "other",
];

const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  too_aggressive: "Too aggressive",
  wrong_timing: "Wrong timing",
  not_enough_data: "Not enough data yet",
  i_handle_this: "I handle this myself",
  other: "Other",
};

const LEARNED_TEXT: Record<RejectReason, string> = {
  too_aggressive: "keep this kind of fix smaller than what it just proposed.",
  wrong_timing: "weigh the timing before it suggests this again.",
  not_enough_data: "wait for stronger proof before it acts on this.",
  i_handle_this: "leave this kind of call to you from now on.",
  other: "take your note into account next time.",
};

const RESOLVE_DISMISS_MS = 12_000;
const RESOLVE_EXIT_MS = 260;

/* ---------- Header ---------- */
function ScreenHeader({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
        {sub && <p className="cd-sub">{sub}</p>}
      </div>
    </header>
  );
}

/* ---------- Confidence → label + tone ---------- */
function confidenceMeta(pct: number): { label: string; tone: "success" | "warn" | "critical" } {
  if (pct >= 75) return { label: "High", tone: "success" };
  if (pct >= 45) return { label: "Medium", tone: "warn" };
  return { label: "Low", tone: "critical" };
}

/* ---------- Reject reason picker ---------- */
function RejectPanel({
  alertId,
  onResult,
  onCancel,
  toast,
}: {
  alertId: string;
  onResult: (result: RejectResult, reason: RejectReason) => void;
  onCancel: () => void;
  toast: DashboardCtx["toast"];
}) {
  const [reason, setReason] = useState<RejectReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    if (busy || !reason) return;
    setBusy(true);
    try {
      const result = await client.rejectProposal({
        alertId,
        reason,
        note: reason === "other" && note.trim() ? note.trim() : undefined,
      });
      onResult(result, reason);
    } catch (err) {
      const msg = err instanceof DashboardApiError ? err.message : "Reject failed.";
      toast(msg, "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cd-reject-panel">
      <p className="cd-caption" style={{ color: "var(--text-2)", fontWeight: 600 }}>
        Why are you rejecting this? It teaches Calderyn what not to do.
      </p>
      <div className="flex flex-col gap-1.5">
        {REJECT_REASONS.map((r) => {
          const active = reason === r;
          return (
            <button
              key={r}
              type="button"
              className={"cd-action-btn" + (active ? " rec" : "")}
              onClick={() => setReason(r)}
              disabled={busy}
            >
              <CDIcon
                name={active ? "check" : "chevronRight"}
                size={15}
                strokeWidth={2}
                style={{ opacity: active ? 1 : 0.45 }}
              />
              <span className="flex-1 text-left">{REJECT_REASON_LABELS[r]}</span>
            </button>
          );
        })}
      </div>
      {reason === "other" && (
        <textarea
          className="cd-input"
          placeholder="In your own words, what was off? e.g. We're clearing this stock on purpose, leave it running."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          rows={2}
        />
      )}
      <div className="flex gap-2">
        <Btn kind="primary" small icon={busy ? "rotate" : "x"} disabled={busy || !reason} onClick={onSubmit}>
          {busy ? "Saving" : "Confirm reject"}
        </Btn>
        <Btn kind="secondary" small disabled={busy} onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ---------- Reflection receipt (post-reject) ---------- */
function ReflectionReceipt({ result, reason }: { result: RejectResult; reason: RejectReason }) {
  const delta = result.delta;
  const deltaTone: "success" | "critical" | "neutral" = delta < 0 ? "critical" : delta > 0 ? "success" : "neutral";
  const deltaLabel = delta === 0 ? "no change" : delta > 0 ? `+${delta}%` : `${delta}%`;
  return (
    <div className="cd-rcpt">
      <div className="cd-rcpt-voice">
        <span className="cd-feed-icon" data-tone="accent">
          <CDIcon name="bolt" size={15} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="cd-rcpt-eyebrow">Calderyn learned something</div>
          <p className="cd-rcpt-text">{result.reflection}</p>
        </div>
      </div>
      <div className="cd-rcpt-box">
        <div className="cd-rcpt-bhead">WHAT CALDERYN LEARNED FROM THIS</div>
        <div className="cd-rcpt-row">
          <span className="cd-feed-icon" data-tone="critical">
            <CDIcon name="x" size={14} strokeWidth={2.2} />
          </span>
          <div className="cd-rcpt-rmain">
            <div className="cd-rcpt-rtitle">You rejected this because</div>
            <div className="cd-rcpt-rsub">&ldquo;{REJECT_REASON_LABELS[reason]}&rdquo;</div>
          </div>
        </div>
        <div className="cd-rcpt-row">
          <span className="cd-feed-icon" data-tone="success">
            <CDIcon name="check" size={14} strokeWidth={2.2} />
          </span>
          <div className="cd-rcpt-rmain">
            <div className="cd-rcpt-rtitle">
              So Calderyn will now
              {result.savedAsRule && (
                <span className="cd-rcpt-saved">
                  <CDIcon name="shield" size={11} strokeWidth={2} /> saved as a rule
                </span>
              )}
            </div>
            <div className="cd-rcpt-rsub">{LEARNED_TEXT[reason]}</div>
          </div>
        </div>
        <div className="cd-rcpt-row">
          <span className="cd-feed-icon" data-tone="accent">
            <CDIcon name="target" size={14} strokeWidth={2} />
          </span>
          <div className="cd-rcpt-rmain">
            <div className="cd-rcpt-rtitle">Trust in this fix</div>
            <div className="cd-rcpt-rsub">Calderyn is now about {result.after}% sure here.</div>
          </div>
          <Pill tone={deltaTone}>{deltaLabel}</Pill>
        </div>
      </div>
    </div>
  );
}

/* ---------- Graduation moment (celebratory, screen-level) ---------- */
type GraduatedInfo = { detectorId: string; actionKind: ActionKind; label: string };

function GraduationMoment({ info, app, onDismiss }: { info: GraduatedInfo; app: DashboardCtx; onDismiss: () => void }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const min = MIN_APPROVALS[actionTier(info.actionKind)];

  const toggle = async () => {
    if (busy) return;
    const next = !on;
    setOn(next); // optimistic
    setBusy(true);
    try {
      await client.toggleFeatureAutonomy({ detectorId: info.detectorId, actionKind: info.actionKind, enabled: next });
    } catch (err) {
      setOn(!next); // revert
      app.toast(err instanceof DashboardApiError ? err.message : "Could not update autopilot.", "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cd-grad">
      <button type="button" className="cd-grad-x" aria-label="Dismiss" onClick={onDismiss}>
        <CDIcon name="x" size={15} strokeWidth={2.2} />
      </button>
      <div className="cd-grad-eyebrow">
        <CDIcon name="bolt" size={13} strokeWidth={2} /> Autopilot unlocked
      </div>
      <h3 className="cd-grad-title">
        You can now let Calderyn <b>{info.label.toLowerCase()}</b> on autopilot
      </h3>
      <div className="cd-grad-check">
        <CDIcon name="check" size={13} strokeWidth={2.8} /> Approved {min} times in a row
      </div>
      <div className="cd-grad-actions">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${on ? "Turn off" : "Turn on"} autopilot for this fix`}
          className="cd-grad-toggle"
          data-on={on}
          disabled={busy}
          onClick={toggle}
        >
          <span className="cd-grad-toggle-knob" />
        </button>
        <span className="cd-grad-toggle-lab">{on ? "Autopilot is on for this fix" : "Turn on autopilot"}</span>
      </div>
      <div className="cd-grad-foot">
        You stay in control. Manage every autopilot fix from the{" "}
        <button type="button" className="cd-grad-link" onClick={() => app.navigate("live-engine")}>
          Live Engine
        </button>
        .
      </div>
    </div>
  );
}

/* ---------- Approve receipt (post-approve) ---------- */
function ApproveReceiptPanel({
  receipt,
  actionKind,
  actionLabel,
}: {
  receipt: ApproveReceipt;
  actionKind: ActionKind;
  actionLabel: string;
}) {
  const delta = receipt.delta;
  const deltaTone: "success" | "critical" | "neutral" = delta < 0 ? "critical" : delta > 0 ? "success" : "neutral";
  const deltaLabel = delta === 0 ? "no change" : delta > 0 ? `+${delta}%` : `${delta}%`;
  const min = MIN_APPROVALS[actionTier(actionKind)];
  const remaining = Math.max(0, min - receipt.cleanApprovals);
  const showProgress = receipt.graduatable && !receipt.justGraduated;
  const cleanPct = Math.min(100, Math.round((receipt.cleanApprovals / Math.max(1, min)) * 100));

  return (
    <div className="cd-rcpt">
      <div className="cd-rcpt-voice">
        <span className="cd-feed-icon" data-tone="success">
          <CDIcon name="check" size={15} strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="cd-rcpt-eyebrow">Calderyn learned something</div>
          <p className="cd-rcpt-text">
            Approved. Calderyn is now about {receipt.after}% sure about this fix and will lean toward doing it for you.
          </p>
        </div>
      </div>
      <div className="cd-rcpt-box">
        <div className="cd-rcpt-row">
          <span className="cd-feed-icon" data-tone="success">
            <CDIcon name="check" size={14} strokeWidth={2.2} />
          </span>
          <div className="cd-rcpt-rmain">
            <div className="cd-rcpt-rtitle">Trust in this fix</div>
            <div className="cd-rcpt-rsub">You taught Calderyn to {actionLabel.toLowerCase()} here.</div>
          </div>
          <Pill tone={deltaTone}>{deltaLabel}</Pill>
        </div>
        {showProgress && (
          <div className="cd-grad-prog">
            <div className="cd-grad-prog-top">
              <span>Toward autopilot</span>
              <span>
                {receipt.cleanApprovals} of {min}
              </span>
            </div>
            <div className="cd-grad-prog-bar">
              <div className="cd-grad-prog-fill" style={{ width: `${cleanPct}%` }} />
            </div>
            <div className="cd-grad-prog-cap">
              {remaining === 0
                ? "Ready to graduate on its next clean approval."
                : `Approve this fix ${remaining} more time${remaining === 1 ? "" : "s"} in a row to let Calderyn run it on autopilot.`}
            </div>
          </div>
        )}
        {receipt.justGraduated && (
          <div className="cd-grad-inline">
            <CDIcon name="bolt" size={14} strokeWidth={2} /> Autopilot unlocked for this fix. Turn it on at the top of the queue.
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Single proposal row ---------- */
type RowView = "idle" | "confirm" | "reject" | "approved" | "rejected";

function ProposalDetails({
  proposal,
  detectorLabel,
  actionLabel,
}: {
  proposal: QueueProposalVM;
  detectorLabel: string;
  actionLabel: string;
}) {
  return (
    <div className="cd-queue-details">
      <div className="cd-queue-details-grid">
        <div>
          <span className="cd-queue-details-label">Why</span>
          <p>{proposal.reasoning || detectorLabel}</p>
        </div>
        <div>
          <span className="cd-queue-details-label">Action</span>
          <p>{actionLabel}</p>
        </div>
        <div>
          <span className="cd-queue-details-label">Trust</span>
          <p>{proposal.confidence}% confident. Approval required.</p>
        </div>
        <div>
          <span className="cd-queue-details-label">Impact</span>
          <p>{money(proposal.dollar_impact)} at stake.</p>
        </div>
      </div>
    </div>
  );
}

type RecentLearning = {
  id: string;
  alertId: string;
  detectorId: string;
  actionKind: string;
  detectorLabel: string;
  actionLabel: string;
  outcome: "approved" | "rejected";
  title: string;
  summary: string;
  detail: string;
  impact: number;
  deltaLabel: string;
  deltaTone: "success" | "critical" | "neutral";
};

function deltaMeta(delta: number): { label: string; tone: "success" | "critical" | "neutral" } {
  return {
    label: delta === 0 ? "no change" : delta > 0 ? `+${delta}%` : `${delta}%`,
    tone: delta < 0 ? "critical" : delta > 0 ? "success" : "neutral",
  };
}

function ResolveCountdown({ outcome }: { outcome: "approved" | "rejected" }) {
  const [remainingMs, setRemainingMs] = useState(RESOLVE_DISMISS_MS);

  useEffect(() => {
    const started = Date.now();
    const interval = window.setInterval(() => {
      const elapsed = Date.now() - started;
      setRemainingMs(Math.max(0, RESOLVE_DISMISS_MS - elapsed));
    }, 120);
    return () => window.clearInterval(interval);
  }, []);

  const progress = Math.max(0, Math.min(1, remainingMs / RESOLVE_DISMISS_MS));
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const color = outcome === "approved" ? "var(--green)" : "var(--red)";

  return (
    <div className="cd-resolve">
      <div
        className="cd-resolve-ring"
        style={{ background: `conic-gradient(${color} ${progress * 360}deg, var(--gray-bg) 0deg)` }}
        aria-label={`Moving to learned section in ${seconds} seconds`}
      >
        <span>{seconds}</span>
      </div>
      <div className="cd-resolve-copy">
        <div>{outcome === "approved" ? "Approval saved" : "Rejection saved"}</div>
        <span>Moving this into what Calderyn learned.</span>
      </div>
    </div>
  );
}

function ProposalRow({
  proposal,
  app,
  onGraduated,
  onResolved,
  compact = false,
  compactTitle,
  compactMeta,
}: {
  proposal: QueueProposalVM;
  app: DashboardCtx;
  onGraduated: (info: GraduatedInfo) => void;
  onResolved: (alertId: string, learning: RecentLearning) => void;
  compact?: boolean;
  compactTitle?: string;
  compactMeta?: string | null;
}) {
  const [view, setView] = useState<RowView>("idle");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejectResult, setRejectResult] = useState<RejectResult | null>(null);
  const [rejectReason, setRejectReason] = useState<RejectReason | null>(null);
  const [approveReceipt, setApproveReceipt] = useState<ApproveReceipt | null>(null);
  const [leaving, setLeaving] = useState(false);
  const resolveStarted = useRef(false);

  const alert = app.alerts.find((a) => a.id === proposal.alertId);
  const detectorLabel = alertDetectorLabel(proposal.detector_id, alert?.evidence ?? {});
  const actionLabel = ACTION_LABELS[proposal.action_kind] ?? proposal.action_kind;
  const displayTitle = compactTitle ?? detectorLabel;
  const confPct = Math.min(100, Math.max(0, proposal.confidence));
  const conf = confidenceMeta(confPct);

  const onApprove = async () => {
    if (busy) return;
    if (!alert) {
      app.toast("Refresh to reload alerts before approving.", "warn", "critical");
      return;
    }
    setBusy(true);
    try {
      // Only a real platform success flips the row to "Approved" (P0-1). A
      // retrying/failed outcome returns ok:false (error toast already fired in
      // executeAction); the row stays actionable so the merchant can retry.
      const { ok, receipt } = await app.executeAction(alert, proposal.action_kind as ActionKind);
      if (ok) {
        setView("approved");
        if (receipt) {
          setApproveReceipt(receipt);
          if (receipt.justGraduated) {
            onGraduated({ detectorId: proposal.detector_id, actionKind: proposal.action_kind as ActionKind, label: actionLabel });
          }
        }
      }
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (resolveStarted.current) return;
    if (view !== "approved" && view !== "rejected") return;

    resolveStarted.current = true;
    let outcome: RecentLearning["outcome"];
    let delta: number;
    let summary: string;
    let detail: string;

    if (view === "approved") {
      if (!approveReceipt) {
        resolveStarted.current = false;
        return;
      }
      outcome = "approved";
      delta = approveReceipt.delta;
      summary = `Approved ${actionLabel.toLowerCase()}`;
      detail = `Trust is now about ${approveReceipt.after}% for this fix.`;
    } else {
      if (!rejectResult || !rejectReason) {
        resolveStarted.current = false;
        return;
      }
      outcome = "rejected";
      delta = rejectResult.delta;
      summary = `Rejected ${actionLabel.toLowerCase()} because ${REJECT_REASON_LABELS[rejectReason]}.`;
      detail = LEARNED_TEXT[rejectReason];
    }

    const { label: deltaLabel, tone: deltaTone } = deltaMeta(delta);
    const learning: RecentLearning = {
      id: `${proposal.alertId}:${outcome}:${Date.now()}`,
      alertId: proposal.alertId,
      detectorId: proposal.detector_id,
      actionKind: proposal.action_kind,
      detectorLabel,
      actionLabel,
      outcome,
      title: proposal.title,
      summary,
      detail,
      impact: proposal.dollar_impact,
      deltaLabel,
      deltaTone,
    };

    let removeTimer: number | undefined;
    const timer = window.setTimeout(() => {
      setLeaving(true);
      removeTimer = window.setTimeout(() => onResolved(proposal.alertId, learning), RESOLVE_EXIT_MS);
    }, RESOLVE_DISMISS_MS);

    return () => {
      window.clearTimeout(timer);
      if (removeTimer) window.clearTimeout(removeTimer);
    };
  }, [actionLabel, approveReceipt, detectorLabel, onResolved, proposal, rejectReason, rejectResult, view]);
  const toggleDetails = () => setDetailsOpen((open) => !open);
  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleDetails();
  };

  return (
    <div
      className="cd-queue-item"
      data-conf={conf.tone}
      data-compact={compact ? "true" : "false"}
      data-leaving={leaving ? "true" : "false"}
    >
      <div
        className="cd-queue-main"
        role="button"
        tabIndex={0}
        aria-expanded={detailsOpen}
        aria-label={`Toggle details for ${displayTitle}`}
        onClick={toggleDetails}
        onKeyDown={onRowKeyDown}
      >
        <span className="cd-feed-icon" data-tone="accent">
          <CDIcon name="bolt" size={14} strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <span className="cd-row-title">{displayTitle}</span>
          {compact && compactMeta && (
            <span className="cd-caption" style={{ color: "var(--text-3)" }}>
              {compactMeta}
            </span>
          )}
          {!compact && proposal.reasoning && (
            <span className="cd-caption" style={{ color: "var(--text-3)" }}>
              {proposal.reasoning}
            </span>
          )}
          <div className="flex items-center gap-2" style={{ marginTop: 2, flexWrap: "wrap" }}>
            {!compact && (
              <Pill tone={conf.tone} icon="bolt">
                {conf.label} confidence - {confPct}%
              </Pill>
            )}
            <span className="cd-caption" style={{ color: "var(--text-3)" }}>
              {compact ? "Needs approval" : `Will ${actionLabel.toLowerCase()}`}
            </span>
            <button
              type="button"
              className="cd-queue-details-toggle"
              data-open={detailsOpen}
              onClick={(event) => {
                event.stopPropagation();
                toggleDetails();
              }}
            >
              Details
              <CDIcon name="chevronDown" size={13} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="cd-queue-side" onClick={(event) => event.stopPropagation()}>
          <div className="text-right">
            <div className="cd-row-num tabular-nums">{money(proposal.dollar_impact)}</div>
            <div className="cd-caption">at stake</div>
          </div>

          {(view === "idle" || view === "reject") && (
            <div className="flex gap-2">
              <Btn
                kind="secondary"
                small
                icon={view === "reject" ? undefined : "x"}
                disabled={busy}
                onClick={() => setView(view === "reject" ? "idle" : "reject")}
              >
                {view === "reject" ? "Cancel" : "Reject"}
              </Btn>
              <Btn kind="primary" small icon="check" disabled={busy || !alert} onClick={() => setView("confirm")}>
                Approve
              </Btn>
            </div>
          )}

          {view === "confirm" && (
            <div className="flex gap-2">
              <Btn kind="secondary" small disabled={busy} onClick={() => setView("idle")}>
                Cancel
              </Btn>
              <Btn kind="primary" small icon={busy ? "rotate" : "check"} disabled={busy} onClick={onApprove}>
                {busy ? "Running" : "Yes, approve"}
              </Btn>
            </div>
          )}

          {view === "approved" && (
            <Pill tone="success" icon="check">
              Approved
            </Pill>
          )}
          {view === "rejected" && (
            <Pill tone="neutral" icon="check">
              Rejected
            </Pill>
          )}
        </div>
      </div>

      <div className="cd-queue-details-wrap" data-open={detailsOpen}>
        <ProposalDetails proposal={proposal} detectorLabel={detectorLabel} actionLabel={actionLabel} />
      </div>

      {view === "confirm" && (
        <div className="cd-queue-confirm">
          <CDIcon name="shield" size={15} strokeWidth={1.9} style={{ color: "var(--green)", flexShrink: 0 }} />
          <span className="cd-caption">
            Approve this? Calderyn will {actionLabel.toLowerCase()} now and learn to do it for you. You can undo it from
            the Live Engine within 48 hours.
          </span>
        </div>
      )}

      {view === "reject" && (
        <RejectPanel
          alertId={proposal.alertId}
          toast={app.toast}
          onResult={(result, reason) => {
            setRejectResult(result);
            setRejectReason(reason);
            setView("rejected");
          }}
          onCancel={() => setView("idle")}
        />
      )}

      {view === "approved" && approveReceipt && (
        <>
          <ApproveReceiptPanel receipt={approveReceipt} actionKind={proposal.action_kind as ActionKind} actionLabel={actionLabel} />
          <ResolveCountdown outcome="approved" />
        </>
      )}

      {view === "rejected" && rejectResult && rejectReason && (
        <>
          <ReflectionReceipt result={rejectResult} reason={rejectReason} />
          <ResolveCountdown outcome="rejected" />
        </>
      )}
    </div>
  );
}

type ProposalGroup = {
  key: string;
  title: string;
  items: QueueProposalVM[];
  representative: QueueProposalVM;
  totalImpact: number;
};

function proposalSectionTitle(p: Pick<QueueProposalVM, "action_kind" | "detector_id">): string {
  switch (p.action_kind) {
    case "increase_campaign_budget":
      return "Campaign Scaling";
    case "reallocate_budget":
      return "Campaign Budget Moves";
    case "pause_campaign":
      return "Campaign Pauses";
    case "reduce_campaign_budget":
      return "Campaign Budget Cuts";
    case "exclude_geo":
      return "Geo Exclusions";
    case "reallocate_inventory":
      return "Inventory Moves";
    case "create_po_draft":
      return "Purchase Orders";
    case "reallocate_spend_sku":
      return "SKU Budget Moves";
    case "adjust_price":
      return "Price Changes";
    case "discontinue_sku":
      return "Product Retirements";
    case "raise_free_ship_threshold":
    case "exclude_sku_free_ship":
      return "Shipping Fixes";
    case "snooze_alert":
      return "Snoozes";
    default:
      return alertDetectorLabel(p.detector_id, {});
  }
}

function opportunityLabel(index: number): string {
  return index === 0 ? "Highest impact opportunity" : `Opportunity ${index + 1}`;
}

function compactMetaForGroupItem(item: QueueProposalVM, titleCounts: Map<string, number>): string | null {
  const cleanTitle = item.title.trim();
  if (!cleanTitle || (titleCounts.get(cleanTitle) ?? 0) > 1) return null;
  return cleanTitle;
}

function proposalGroupKey(p: QueueProposalVM): string {
  return proposalSectionTitle(p);
}

function groupProposals(proposals: QueueProposalVM[]): ProposalGroup[] {
  const byKey = new Map<string, QueueProposalVM[]>();
  for (const p of proposals) {
    const key = proposalGroupKey(p);
    byKey.set(key, [...(byKey.get(key) ?? []), p]);
  }

  return [...byKey.entries()].map(([key, values]) => {
    const items = [...values].sort((a, b) => b.dollar_impact - a.dollar_impact);
    return {
      key,
      title: proposalSectionTitle(items[0]),
      items,
      representative: items[0],
      totalImpact: items.reduce((sum, item) => sum + item.dollar_impact, 0),
    };
  });
}

function ProposalGroupRow({
  group,
  app,
  onGraduated,
  onResolved,
}: {
  group: ProposalGroup;
  app: DashboardCtx;
  onGraduated: (info: GraduatedInfo) => void;
  onResolved: (alertId: string, learning: RecentLearning) => void;
}) {
  const [open, setOpen] = useState(false);
  const p = group.representative;
  const actionLabel = ACTION_LABELS[p.action_kind] ?? p.action_kind;
  const conf = confidenceMeta(Math.min(100, Math.max(0, p.confidence)));
  const titleCounts = new Map<string, number>();
  for (const item of group.items) {
    const cleanTitle = item.title.trim();
    if (cleanTitle) titleCounts.set(cleanTitle, (titleCounts.get(cleanTitle) ?? 0) + 1);
  }

  if (group.items.length === 1) {
    return <ProposalRow proposal={p} app={app} onGraduated={onGraduated} onResolved={onResolved} />;
  }

  return (
    <div className="cd-queue-group" data-conf={conf.tone}>
      <button type="button" className="cd-queue-group-head" data-open={open} onClick={() => setOpen((v) => !v)}>
        <span className="cd-feed-icon" data-tone="accent">
          <CDIcon name="bolt" size={14} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="cd-queue-group-title">
            <span>{group.title}</span>
            <Pill tone="neutral">{group.items.length} alerts</Pill>
            <Pill tone={conf.tone}>{p.confidence}% confident</Pill>
          </div>
          <div className="cd-caption" style={{ color: "var(--text-3)", marginTop: 4 }}>
            {group.items.length} alerts need {actionLabel.toLowerCase()}.
          </div>
          <div className="cd-queue-group-action">
            Will {actionLabel.toLowerCase()} <span>{open ? "Hide alerts" : "View alerts"}</span>
            <CDIcon name="chevronDown" size={14} strokeWidth={2} />
          </div>
        </div>
        <div className="text-right">
          <div className="cd-row-num tabular-nums">{money(group.totalImpact)}</div>
          <div className="cd-caption">total at stake</div>
        </div>
      </button>

      <div className="cd-queue-group-body" data-open={open}>
        <div className="cd-queue-group-note">
          Same recommendation, sorted by impact. Open Details only when you need the why.
        </div>
        <div className="cd-queue-group-list">
          {group.items.map((item, index) => (
            <ProposalRow
              key={`${item.alertId}:${item.action_kind}`}
              proposal={item}
              app={app}
              onGraduated={onGraduated}
              onResolved={onResolved}
              compact
              compactTitle={opportunityLabel(index)}
              compactMeta={compactMetaForGroupItem(item, titleCounts)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Learned rules section ---------- */
function groupRecentLearnings(events: RecentLearning[]) {
  const groups = new Map<string, { key: string; label: string; events: RecentLearning[]; totalImpact: number }>();
  for (const event of events) {
    const key = `${event.outcome}:${event.detectorId}:${event.actionKind}`;
    const existing = groups.get(key) ?? {
      key,
      label: `${event.actionLabel} ${event.outcome === "approved" ? "approvals" : "rejections"}`,
      events: [],
      totalImpact: 0,
    };
    existing.events.push(event);
    existing.totalImpact += event.impact;
    groups.set(key, existing);
  }
  return [...groups.values()];
}

function LearnedRulesSection({ rules, recent, app }: { rules: LearnedRuleVM[]; recent: RecentLearning[]; app: DashboardCtx }) {
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const recentGroups = groupRecentLearnings(recent);

  const onUndo = async (rule: LearnedRuleVM) => {
    if (undoingId) return;
    setUndoingId(rule.id);
    try {
      await client.undoRule(rule.id);
      app.refresh();
      app.toast("Rule removed. Calderyn will consider these actions again.", "undo");
    } catch (err) {
      const msg = err instanceof DashboardApiError ? err.message : "Could not remove rule.";
      app.toast(msg, "warn", "critical");
    } finally {
      setUndoingId(null);
    }
  };

  return (
    <Card pad={false}>
      <div className="cd-pad-x cd-pad-t">
        <h2 className="cd-h2">What Calderyn has learned</h2>
        <p className="cd-caption" style={{ color: "var(--text-3)", marginTop: 2 }}>
          Latest approvals and rejections from this session, grouped by what the engine adjusted.
        </p>
      </div>
      {recentGroups.length > 0 && (
        <div className="cd-recent-learned">
          {recentGroups.map((group) => (
            <div key={group.key} className="cd-recent-group">
              <div className="cd-recent-head">
                <span>{group.label}</span>
                <span>
                  {group.events.length} {group.events.length === 1 ? "alert" : "alerts"} - {money(group.totalImpact)}
                </span>
              </div>
              {group.events.map((event) => (
                <div key={event.id} className="cd-row" style={{ cursor: "default" }}>
                  <span className="cd-feed-icon" data-tone={event.outcome === "approved" ? "success" : "critical"}>
                    <CDIcon name={event.outcome === "approved" ? "check" : "x"} size={14} strokeWidth={2.1} />
                  </span>
                  <span className="min-w-0 flex-1 cd-caption" style={{ color: "var(--text-2)" }}>
                    <b>{event.summary}</b>
                    <small>{event.detail}</small>
                  </span>
                  <Pill tone={event.deltaTone}>{event.deltaLabel}</Pill>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {rules.length === 0 && recentGroups.length === 0 ? (
        <Placeholder
          icon="scan"
          title="Nothing learned yet"
          sub="Approve or reject suggestions and Calderyn will summarize what changed here."
        />
      ) : (
        rules.length > 0 && (
          <div className="cd-rows">
            <div className="cd-persisted-head">Standing rules from prior rejections</div>
            {rules.map((rule) => (
              <div key={rule.id} className="cd-row" style={{ cursor: "default" }}>
                <span className="cd-feed-icon" data-tone="neutral">
                  <CDIcon name="shield" size={14} strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1 cd-caption" style={{ color: "var(--text-2)" }}>
                  {rule.summary}
                </span>
                <Btn
                  kind="secondary"
                  small
                  icon={undoingId === rule.id ? "rotate" : "undo"}
                  disabled={undoingId === rule.id}
                  onClick={() => onUndo(rule)}
                >
                  Undo
                </Btn>
              </div>
            ))}
          </div>
        )
      )}
    </Card>
  );
}

/* ---------- Main screen ---------- */
export default function ActionQueue({ app }: { app: DashboardCtx }) {
  // Local copy so a worked-through card (showing its reflection receipt) isn't
  // wiped before the next ctx refresh. Track the ctx reference to detect reloads.
  const [proposals, setProposals] = useState<QueueProposalVM[]>(app.actionQueue);
  const [recentLearnings, setRecentLearnings] = useState<RecentLearning[]>([]);
  const ctxQueueRef = useRef(app.actionQueue);

  useEffect(() => {
    if (ctxQueueRef.current !== app.actionQueue) {
      ctxQueueRef.current = app.actionQueue;
      setProposals(app.actionQueue);
    }
  }, [app.actionQueue]);

  const sorted = [...proposals].sort((a, b) => b.confidence - a.confidence);
  const groups = groupProposals(sorted).sort(
    (a, b) => b.representative.confidence - a.representative.confidence || b.totalImpact - a.totalImpact,
  );
  const loading = app.loading && sorted.length === 0;
  // The most recent pair to cross into graduated this session drives the
  // celebratory "autopilot unlocked" moment at the top of the queue.
  const [graduated, setGraduated] = useState<GraduatedInfo | null>(null);
  const onResolved = useCallback((alertId: string, learning: RecentLearning) => {
    setProposals((current) => current.filter((item) => item.alertId !== alertId));
    setRecentLearnings((current) => [learning, ...current.filter((item) => item.alertId !== alertId)].slice(0, 12));
  }, []);

  return (
    <div className="cd-screen">
      <ScreenHeader title="Action Queue" />

      <CalibrationLevelHeader
        pct={app.calibration?.pct ?? null}
        nearGraduation={app.calibration?.nearGraduation ?? 0}
      />

      {graduated && <GraduationMoment info={graduated} app={app} onDismiss={() => setGraduated(null)} />}

      {loading ? (
        <Card>
          <Placeholder icon="scan" title="Loading action queue" sub="Calibration is ranking your proposals." />
        </Card>
      ) : sorted.length === 0 ? (
        <Card>
          <Placeholder
            icon="check"
            title="Nothing needs you right now"
            sub="Calderyn will line up suggestions here as it spots money leaks. Approving and rejecting them trains your agent."
          />
        </Card>
      ) : (
        <div>
          <div className="cd-row-between" style={{ marginBottom: 10, padding: "0 2px" }}>
            <h2 className="cd-h2" style={{ margin: 0 }}>
              {groups.length} action {groups.length === 1 ? "section" : "sections"}{" "}
              <span style={{ color: "var(--text-3)", fontWeight: 400 }}>need your OK</span>
            </h2>
            <span className="cd-caption" style={{ color: "var(--text-3)" }}>
              {sorted.length} total alerts - highest confidence first
            </span>
          </div>
          <Card pad={false}>
            <div className="cd-rows">
              {groups.map((g) => (
                <ProposalGroupRow key={g.key} group={g} app={app} onGraduated={setGraduated} onResolved={onResolved} />
              ))}
            </div>
          </Card>
        </div>
      )}

      <LearnedRulesSection rules={app.learnedRules} recent={recentLearnings} app={app} />
    </div>
  );
}
