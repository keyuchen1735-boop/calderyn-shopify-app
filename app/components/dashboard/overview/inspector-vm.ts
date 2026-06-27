// Normalises the Inspector ("why Calderyn flagged it") panel data so a single
// component can render BOTH a durable trace row (history) and a still-pending
// proposal (flagged, needs approval). Trace rows already carry full inspector
// detail from the server; pending rows are assembled client-side from the
// proposal + its alert evidence + the matching pipeline call. Nothing fabricated.
import type {
  TraceEventVM,
  PipelineCallVM,
  PipelineFactorVM,
  InspectorStat,
} from "~/lib/calibration/live-engine-types";
import type { AlertVM, QueueProposalVM } from "~/components/dashboard/view-models";
import { ACTION_LABELS } from "~/components/dashboard/format";
import {
  pendingEvidenceStats,
  pendingApproveText,
  PENDING_DENY_TEXT,
  PENDING_TRUST_LINE,
} from "~/lib/calibration/pending-inspector";

export type { InspectorStat };

export interface InspectorVM {
  /** "pending" drives the why + approve/deny layout; "trace" the history layout. */
  variant: "pending" | "trace";
  /** Tag pill, e.g. "NEEDS YOU" for pending or the trace tag (AUTO/APPROVED/…). */
  tag: string;
  /** Clock for history rows, "now" for a live pending item. */
  time: string;
  title: string;
  /** WHAT IT SAW / WHY CALDERYN FLAGGED THIS — the plain-language signal. */
  signal: string;
  /** Trace evidence chips (already formatted server-side); empty for pending. */
  evidence: string[];
  /** Pending key figures, humanized from the alert evidence; empty for trace. */
  stats: InspectorStat[];
  /** HOW IT WEIGHED THIS — confidence factor breakdown (trace layout only). */
  factors: PipelineFactorVM[];
  /** Blended confidence (0-100), null when unknown. */
  confidence: number | null;
  /** The per-pair auto-act bar (0-100). */
  threshold: number;
  /** DECISION — the decision pill (trace layout). */
  decisionLabel: string;
  /** DECISION — plain-language note (trace layout). */
  decisionNote: string;
  /** Pending only — what approving does. */
  approveText: string | null;
  /** Pending only — what denying does. */
  denyText: string | null;
  /** Pending only — one plain line on why it asks instead of acting. */
  trustLine: string | null;
  /** Whether to render the money row. */
  showMoney: boolean;
  /** Signed money for the money row (cents). */
  moneyCents: number;
  /** Label for the money row, e.g. "Ad spend protected" / "At stake". */
  moneyLabel: string;
}

/** Default auto-act bar when no pipeline call is available for a pending item. */
const DEFAULT_THRESHOLD = 75;

/** Inspector for a durable trace (history) row — already fully populated server-side. */
export function inspectorFromTrace(t: TraceEventVM): InspectorVM {
  return {
    variant: "trace",
    tag: t.tag,
    time: t.time,
    title: t.title,
    signal: t.signal,
    evidence: t.evidence ?? [],
    stats: [],
    factors: t.factors ?? [],
    confidence: t.confidence,
    threshold: t.threshold,
    decisionLabel: t.decisionLabel,
    decisionNote: t.decisionNote,
    approveText: null,
    denyText: null,
    trustLine: null,
    showMoney: t.tag !== "BLOCKED" && t.moneyCents !== 0,
    moneyCents: t.moneyCents,
    moneyLabel: t.tag === "AUTO" ? "Ad spend protected" : t.tag === "UNDONE" ? "Reversed" : "Impact",
  };
}

/**
 * Inspector for a pending (flagged) proposal: the signal comes from the alert
 * narrative (falling back to the proposal's one-liner), the figures from the
 * alert's evidence, and the bar from the matching pipeline call. The decision is
 * framed as the concrete outcome of approving vs. denying — no confidence math,
 * just one plain line on why Calderyn is asking rather than acting. Humanization
 * + copy come from the shared pending-inspector helper so the embedded surface
 * (built server-side) renders an identical card.
 */
export function inspectorFromPending(
  p: QueueProposalVM,
  alert: AlertVM | undefined,
  call: PipelineCallVM | undefined,
): InspectorVM {
  const actionLabel = ACTION_LABELS[p.action_kind] ?? p.action_kind;
  return {
    variant: "pending",
    tag: "NEEDS YOU",
    time: "now",
    title: p.title,
    signal: alert?.narrative ?? p.reasoning,
    evidence: [],
    stats: pendingEvidenceStats(alert?.evidence),
    factors: call?.factors ?? [],
    confidence: call?.confidence ?? p.confidence,
    threshold: call?.threshold ?? DEFAULT_THRESHOLD,
    decisionLabel: "NEEDS YOUR APPROVAL",
    decisionNote: "Calderyn is confident enough to suggest this, not yet to do it on its own.",
    approveText: pendingApproveText(actionLabel),
    denyText: PENDING_DENY_TEXT,
    trustLine: PENDING_TRUST_LINE,
    showMoney: p.dollar_impact !== 0,
    moneyCents: p.dollar_impact,
    moneyLabel: "At stake",
  };
}
