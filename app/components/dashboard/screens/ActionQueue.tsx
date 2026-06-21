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
import { Card, Meter, Placeholder } from "../ui";
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

/* ---------- Confidence label ---------- */
function confidenceLabel(pct: number): string {
  if (pct >= 75) return "High";
  if (pct >= 45) return "Medium";
  return "Low";
}

/* ---------- Reject picker ---------- */
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
  const [reason, setReason] = useState<RejectReason>("too_aggressive");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    if (busy) return;
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
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      <label className="cd-caption" style={{ color: "var(--text-2)", fontWeight: 600 }}>
        Why are you rejecting this?
      </label>
      <select
        className="cd-input"
        value={reason}
        onChange={(e) => setReason(e.target.value as RejectReason)}
        disabled={busy}
        style={{
          fontSize: "0.875rem",
          padding: "6px 10px",
          borderRadius: "var(--radius, 8px)",
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: "var(--text-1)",
          cursor: "pointer",
        }}
      >
        {REJECT_REASONS.map((r) => (
          <option key={r} value={r}>
            {REJECT_REASON_LABELS[r]}
          </option>
        ))}
      </select>
      {reason === "other" && (
        <textarea
          className="cd-input"
          placeholder="Add a note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          rows={2}
          style={{
            fontSize: "0.875rem",
            padding: "6px 10px",
            borderRadius: "var(--radius, 8px)",
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            color: "var(--text-1)",
            resize: "vertical",
          }}
        />
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="cd-btn"
          style={{ background: "var(--red)", color: "#fff", opacity: busy ? 0.6 : 1 }}
          disabled={busy}
          onClick={onSubmit}
        >
          {busy ? (
            <>
              <CDIcon name="rotate" size={13} strokeWidth={2} />
              Rejecting&hellip;
            </>
          ) : (
            <>
              <CDIcon name="x" size={13} strokeWidth={2.2} />
              Confirm reject
            </>
          )}
        </button>
        <button className="cd-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
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
  const confLabel = confidenceLabel(confPct);
  const confTone: "success" | "accent" | "warn" =
    confPct >= 75 ? "success" : confPct >= 45 ? "accent" : "warn";

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
    <div className="cd-row" style={{ alignItems: "flex-start", gap: 12, flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, width: "100%" }}>
        <span className="cd-feed-icon" data-tone="accent">
          <CDIcon name="bolt" size={14} strokeWidth={1.9} />
        </span>
        <div
          className="min-w-0 flex-1"
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
            <span className="cd-row-title">{proposal.title}</span>
          </div>
          <div className="cd-caption" style={{ color: "var(--text-2)" }}>
            {detectorLabel} &middot; {actionLabel}
          </div>
          <div className="cd-caption" style={{ color: "var(--text-3)" }}>
            {proposal.reasoning}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <div style={{ flex: 1, maxWidth: 120 }}>
              <Meter pct={confPct} tone={confTone} height={5} />
            </div>
            <span className="cd-caption" style={{ color: "var(--text-2)", whiteSpace: "nowrap" }}>
              {confLabel} confidence ({confPct}%)
            </span>
          </div>
        </div>
        <div
          style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}
        >
          <div
            className="cd-row-num tabular-nums"
            style={{ color: "var(--red)", whiteSpace: "nowrap" }}
          >
            {money(proposal.dollar_impact)}
          </div>
          <div className="cd-caption">at risk</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              className="cd-btn"
              style={{ color: "var(--red)" }}
              disabled={busy}
              onClick={() => setShowReject((v) => !v)}
            >
              <CDIcon name="x" size={13} strokeWidth={2.2} />
              {showReject ? "Cancel" : "Reject"}
            </button>
            <button
              className="cd-btn cd-btn-accent"
              disabled={busy || !alert}
              onClick={onApprove}
            >
              {busy ? (
                <>
                  <CDIcon name="rotate" size={13} strokeWidth={2} />
                  Running&hellip;
                </>
              ) : (
                <>
                  <CDIcon name="check" size={13} strokeWidth={2.2} />
                  Approve
                </>
              )}
            </button>
          </div>
        </div>
      </div>
      {showReject && (
        <div style={{ paddingLeft: 26, width: "100%" }}>
          <RejectPanel
            alertId={proposal.alertId}
            toast={app.toast}
            onDone={() => {
              setShowReject(false);
              onRejected(proposal.alertId);
            }}
            onCancel={() => setShowReject(false)}
          />
        </div>
      )}
    </div>
  );
}

/* ---------- Learned rules section ---------- */
function LearnedRulesSection({
  rules,
  app,
}: {
  rules: LearnedRuleVM[];
  app: DashboardCtx;
}) {
  const [undoingId, setUndoingId] = useState<string | null>(null);

  const onUndo = async (rule: LearnedRuleVM) => {
    if (undoingId) return;
    setUndoingId(rule.id);
    try {
      await client.undoRule(rule.id);
      app.refresh();
      app.toast("Rule removed — Calderyn will consider these actions again.", "undo");
    } catch (err) {
      const msg = err instanceof DashboardApiError ? err.message : "Could not remove rule.";
      app.toast(msg, "warn", "critical");
    } finally {
      setUndoingId(null);
    }
  };

  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <h2 className="cd-h2" style={{ marginBottom: 2 }}>
            What Calderyn has learned
          </h2>
          <p className="cd-caption" style={{ color: "var(--text-3)" }}>
            Rules picked up from your rejections. Undo any rule to let Calderyn reconsider.
          </p>
        </div>
        {rules.length === 0 ? (
          <p className="cd-caption" style={{ color: "var(--text-3)" }}>
            Nothing learned yet. As you reject suggestions, the rules Calderyn picks up will
            appear here.
          </p>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className="cd-row"
              style={{ alignItems: "center", justifyContent: "space-between", gap: 12 }}
            >
              <span className="cd-caption" style={{ color: "var(--text-2)", flex: 1 }}>
                {rule.summary}
              </span>
              <button
                className="cd-btn"
                disabled={undoingId === rule.id}
                onClick={() => onUndo(rule)}
              >
                {undoingId === rule.id ? (
                  <CDIcon name="rotate" size={13} strokeWidth={2} />
                ) : (
                  <CDIcon name="undo" size={13} strokeWidth={2} />
                )}
                Undo
              </button>
            </div>
          ))
        )}
      </div>
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

  const onRejected = (alertId: string) => {
    setProposals((prev) => prev.filter((p) => p.alertId !== alertId));
  };

  return (
    <div className="cd-screen">
      <ScreenHeader
        title="Action Queue"
        sub="Calibration-ranked proposals — highest confidence first."
      />

      {app.loading && sorted.length === 0 ? (
        <Placeholder title="Loading action queue…" />
      ) : sorted.length === 0 ? (
        <Card>
          <Placeholder
            title="No proposals right now"
            sub="Check back after the next detector sweep."
          />
        </Card>
      ) : (
        <Card>
          {sorted.map((p) => (
            <ProposalRow
              key={`${p.alertId}:${p.action_kind}`}
              proposal={p}
              app={app}
              onRejected={onRejected}
            />
          ))}
        </Card>
      )}

      <div style={{ marginTop: 24 }}>
        <LearnedRulesSection rules={app.learnedRules} app={app} />
      </div>
    </div>
  );
}
