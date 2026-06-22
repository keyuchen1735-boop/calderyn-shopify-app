// Calderyn DashV2 — Action Queue v2 screen (dashboard mirror of the embedded
// app.queue.tsx). Leveling header + calibration-ranked proposal cards with a
// one-click Approve (confirm guard, runs the existing executeAction path) and a
// reject -> reason chips -> "what Calderyn learned" reflection receipt.
//
// Reject re-derives detector/action/impact from the TRUSTED alert server-side
// (client.rejectProposal -> /dashboard/api/queue/reject) and executes NOTHING;
// it returns the reject receipt (reflection + trust delta + savedAsRule) that
// drives the receipt card. Learned rules section + undo unchanged.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card, Pill, Btn, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money, ACTION_LABELS, alertDetectorLabel } from "../format";
import CalibrationLevelHeader from "../CalibrationLevelHeader";
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

/* ---------- Single proposal row ---------- */
type RowView = "idle" | "confirm" | "reject" | "approved" | "rejected";

function ProposalRow({ proposal, app }: { proposal: QueueProposalVM; app: DashboardCtx }) {
  const [view, setView] = useState<RowView>("idle");
  const [busy, setBusy] = useState(false);
  const [rejectResult, setRejectResult] = useState<RejectResult | null>(null);
  const [rejectReason, setRejectReason] = useState<RejectReason | null>(null);

  const alert = app.alerts.find((a) => a.id === proposal.alertId);
  const detectorLabel = alertDetectorLabel(proposal.detector_id, alert?.evidence ?? {});
  const actionLabel = ACTION_LABELS[proposal.action_kind] ?? proposal.action_kind;
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
      await app.executeAction(alert, proposal.action_kind as ActionKind);
      setView("approved");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cd-queue-item" data-conf={conf.tone}>
      <div className="cd-queue-main">
        <span className="cd-feed-icon" data-tone="accent">
          <CDIcon name="bolt" size={14} strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <span className="cd-row-title">{detectorLabel}</span>
          {proposal.reasoning && (
            <span className="cd-caption" style={{ color: "var(--text-3)" }}>
              {proposal.reasoning}
            </span>
          )}
          <div className="flex items-center gap-2" style={{ marginTop: 2, flexWrap: "wrap" }}>
            <Pill tone={conf.tone} icon="bolt">
              {conf.label} confidence · {confPct}%
            </Pill>
            <span className="cd-caption" style={{ color: "var(--text-3)" }}>
              Will {actionLabel.toLowerCase()}
            </span>
          </div>
        </div>

        <div className="cd-queue-side">
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

      {view === "rejected" && rejectResult && rejectReason && (
        <ReflectionReceipt result={rejectResult} reason={rejectReason} />
      )}
    </div>
  );
}

/* ---------- Learned rules section ---------- */
function LearnedRulesSection({ rules, app }: { rules: LearnedRuleVM[]; app: DashboardCtx }) {
  const [undoingId, setUndoingId] = useState<string | null>(null);

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
          Rules picked up from your rejections. Undo any rule to let Calderyn reconsider it.
        </p>
      </div>
      {rules.length === 0 ? (
        <Placeholder
          icon="scan"
          title="Nothing learned yet"
          sub="As you reject suggestions, the rules Calderyn picks up about how you run your shop will appear here."
        />
      ) : (
        <div className="cd-rows">
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
      )}
    </Card>
  );
}

/* ---------- Main screen ---------- */
export default function ActionQueue({ app }: { app: DashboardCtx }) {
  // Local copy so a worked-through card (showing its reflection receipt) isn't
  // wiped before the next ctx refresh. Track the ctx reference to detect reloads.
  const [proposals, setProposals] = useState<QueueProposalVM[]>(app.actionQueue);
  const ctxQueueRef = useRef(app.actionQueue);

  useEffect(() => {
    if (ctxQueueRef.current !== app.actionQueue) {
      ctxQueueRef.current = app.actionQueue;
      setProposals(app.actionQueue);
    }
  }, [app.actionQueue]);

  const sorted = [...proposals].sort((a, b) => b.confidence - a.confidence);
  const loading = app.loading && sorted.length === 0;

  return (
    <div className="cd-screen">
      <ScreenHeader title="Action Queue" />

      <CalibrationLevelHeader
        pct={app.calibration?.pct ?? null}
        nearGraduation={app.calibration?.nearGraduation ?? 0}
      />

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
              {sorted.length} waiting <span style={{ color: "var(--text-3)", fontWeight: 400 }}>need your OK</span>
            </h2>
            <span className="cd-caption" style={{ color: "var(--text-3)" }}>
              Highest confidence first
            </span>
          </div>
          <Card pad={false}>
            <div className="cd-rows">
              {sorted.map((p) => (
                <ProposalRow key={`${p.alertId}:${p.action_kind}`} proposal={p} app={app} />
              ))}
            </div>
          </Card>
        </div>
      )}

      <LearnedRulesSection rules={app.learnedRules} app={app} />
    </div>
  );
}
