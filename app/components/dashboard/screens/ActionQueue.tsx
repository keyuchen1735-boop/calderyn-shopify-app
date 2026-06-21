// Calderyn DashV2 — Action Queue screen.
// Calibration-ranked proposals: each open alert paired with its recommended
// action, sorted by confidence (highest first). The Approve button executes
// the proposal via the existing executeAction path — same guards, same audit
// trail. No new executor; re-uses the DashboardCtx action pipeline.
//
// Reject flow (parity with app.queue.tsx):
//   - A per-row "Reject" toggle reveals a reason picker (5 values) + optional note.
//   - On submit, calls client.rejectProposal → POST /dashboard/api/queue/reject.
//   - Server re-derives detector/action/impact from the TRUSTED alert (never the body).
//   - Returns {reflection}; shown as a toast. Reject NEVER executes any action.
//   - Rejected row is removed from local list (same UX as Polaris embedded).
//
// Learned rules section: lists LearnedRuleVM[] from ctx + undo button per rule.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card, Pill, Btn, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money, ACTION_LABELS, alertDetectorLabel } from "../format";
import type { ActionKind, DashboardCtx } from "../context";
import type { LearnedRuleVM, QueueProposalVM } from "../view-models";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import type { RejectReason } from "~/lib/types";

/* ---------- Reject reason labels (mirrors app.queue.tsx) ---------- */
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
  onDone,
  onCancel,
  toast,
}: {
  alertId: string;
  onDone: () => void;
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
      const { reflection } = await client.rejectProposal({
        alertId,
        reason,
        note: reason === "other" && note.trim() ? note.trim() : undefined,
      });
      toast(reflection, "check");
      onDone();
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
        Why are you rejecting this? Calderyn learns from your reason.
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
          placeholder="Add a note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          rows={2}
        />
      )}
      <div className="flex gap-2">
        <Btn kind="primary" small icon={busy ? "rotate" : "x"} disabled={busy || !reason} onClick={onSubmit}>
          {busy ? "Rejecting" : "Confirm reject"}
        </Btn>
        <Btn kind="secondary" small disabled={busy} onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

/* ---------- Single proposal row ---------- */
function ProposalRow({
  proposal,
  app,
  onRejected,
}: {
  proposal: QueueProposalVM;
  app: DashboardCtx;
  onRejected: (alertId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showReject, setShowReject] = useState(false);

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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cd-queue-item">
      <div className="cd-queue-main">
        <span className="cd-feed-icon" data-tone="accent">
          <CDIcon name="bolt" size={14} strokeWidth={1.9} />
        </span>

        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <span className="cd-row-title">{proposal.title}</span>
          <span className="cd-caption" style={{ color: "var(--text-2)" }}>
            {detectorLabel} · {actionLabel}
          </span>
          {proposal.reasoning && (
            <span className="cd-caption" style={{ color: "var(--text-3)" }}>
              {proposal.reasoning}
            </span>
          )}
          <div className="flex items-center gap-2" style={{ marginTop: 2 }}>
            <Pill tone={conf.tone} icon="bolt">
              {conf.label} confidence · {confPct}%
            </Pill>
          </div>
        </div>

        <div className="cd-queue-side">
          <div className="text-right">
            <div className="cd-row-num tabular-nums" style={{ color: "var(--red)" }}>
              {money(proposal.dollar_impact)}
            </div>
            <div className="cd-caption">at risk</div>
          </div>
          <div className="flex gap-2">
            <Btn
              kind="secondary"
              small
              icon={showReject ? undefined : "x"}
              disabled={busy}
              onClick={() => setShowReject((v) => !v)}
            >
              {showReject ? "Cancel" : "Reject"}
            </Btn>
            <Btn
              kind="primary"
              small
              icon={busy ? "rotate" : "check"}
              disabled={busy || !alert}
              onClick={onApprove}
            >
              {busy ? "Running" : "Approve"}
            </Btn>
          </div>
        </div>
      </div>

      {showReject && (
        <RejectPanel
          alertId={proposal.alertId}
          toast={app.toast}
          onDone={() => {
            setShowReject(false);
            onRejected(proposal.alertId);
          }}
          onCancel={() => setShowReject(false)}
        />
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
  // Local copy so we can optimistically remove a rejected row without waiting for
  // a full context refresh. Track the ctx reference to detect parent reloads.
  const [proposals, setProposals] = useState<QueueProposalVM[]>(app.actionQueue);
  const ctxQueueRef = useRef(app.actionQueue);

  // Sync from ctx whenever the parent refreshes (e.g. after undoRule → app.refresh()).
  // We compare by reference: DashboardApp.tsx replaces the array on every load(),
  // so a new reference means new data that should overwrite local state.
  useEffect(() => {
    if (ctxQueueRef.current !== app.actionQueue) {
      ctxQueueRef.current = app.actionQueue;
      setProposals(app.actionQueue);
    }
  }, [app.actionQueue]);

  const sorted = [...proposals].sort((a, b) => b.confidence - a.confidence);
  const atRisk = sorted.reduce((s, p) => s + p.dollar_impact, 0);
  const loading = app.loading && sorted.length === 0;

  return (
    <div className="cd-screen">
      <ScreenHeader
        title="Action Queue"
        sub={
          loading
            ? "Lining up what Calderyn wants to do…"
            : sorted.length === 0
              ? "Approve or reject what Calderyn suggests to train your agent."
              : `${sorted.length} waiting · ${money(atRisk)} at risk · approve or reject to train your agent`
        }
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
        <Card pad={false}>
          <div className="cd-rows">
            {sorted.map((p) => (
              <ProposalRow
                key={`${p.alertId}:${p.action_kind}`}
                proposal={p}
                app={app}
                onRejected={(id) => setProposals((prev) => prev.filter((x) => x.alertId !== id))}
              />
            ))}
          </div>
        </Card>
      )}

      <LearnedRulesSection rules={app.learnedRules} app={app} />
    </div>
  );
}
