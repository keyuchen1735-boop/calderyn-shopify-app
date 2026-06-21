// Calderyn DashV2 — Action Queue screen.
// Calibration-ranked proposals: each open alert paired with its recommended
// action, sorted by confidence (highest first). The Approve button executes
// the proposal via the existing executeAction path — same guards, same audit
// trail. No new executor; re-uses the DashboardCtx action pipeline.
import { useState, type ReactNode } from "react";
import { Card, Meter, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money, ACTION_LABELS, alertDetectorLabel } from "../format";
import type { ActionKind, DashboardCtx } from "../context";
import type { QueueProposalVM } from "../view-models";

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

/* ---------- Single proposal row ---------- */
function ProposalRow({
  proposal,
  app,
}: {
  proposal: QueueProposalVM;
  app: DashboardCtx;
}) {
  const [busy, setBusy] = useState(false);

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
      // Alert not in the current loaded set — surface info-toast, not an error.
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
    <div className="cd-row" style={{ alignItems: "flex-start", gap: 12 }}>
      <span className="cd-feed-icon" data-tone="accent">
        <CDIcon name="bolt" size={14} strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
        <div
          className="cd-row-num tabular-nums"
          style={{ color: "var(--red)", whiteSpace: "nowrap" }}
        >
          {money(proposal.dollar_impact)}
        </div>
        <div className="cd-caption">at risk</div>
        <button
          className="cd-btn cd-btn-accent"
          disabled={busy || !alert}
          onClick={onApprove}
          style={{ marginTop: 4 }}
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
  );
}

/* ---------- Main screen ---------- */
export default function ActionQueue({ app }: { app: DashboardCtx }) {
  const proposals = app.actionQueue;
  const sorted = [...proposals].sort((a, b) => b.confidence - a.confidence);

  return (
    <div className="cd-screen">
      <ScreenHeader
        title="Action Queue"
        sub="Calibration-ranked proposals — highest confidence first."
      />

      {app.loading && sorted.length === 0 ? (
        <Placeholder title="Loading action queue…" />
      ) : sorted.length === 0 ? (
        <Placeholder title="No proposals right now" sub="Check back after the next detector sweep." />
      ) : (
        <Card>
          {sorted.map((p) => (
            <ProposalRow key={`${p.alertId}:${p.action_kind}`} proposal={p} app={app} />
          ))}
        </Card>
      )}
    </div>
  );
}
