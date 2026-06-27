// Normalises the Inspector ("why Calderyn flagged it") panel data so a single
// component can render BOTH a durable trace row (history) and a still-pending
// proposal (flagged, needs approval). Trace rows already carry full inspector
// detail from the server; pending rows are assembled client-side from the
// proposal + its alert evidence + the matching pipeline call. Nothing fabricated.
import type {
  TraceEventVM,
  PipelineCallVM,
  PipelineFactorVM,
} from "~/lib/calibration/live-engine-types";
import type { AlertVM, QueueProposalVM } from "~/components/dashboard/view-models";

export interface InspectorVM {
  /** Tag pill, e.g. "NEEDS YOU" for pending or the trace tag (AUTO/APPROVED/…). */
  tag: string;
  /** Clock for history rows, "now" for a live pending item. */
  time: string;
  title: string;
  /** WHAT IT SAW — the plain-language signal. */
  signal: string;
  /** WHAT IT SAW — evidence chips. */
  evidence: string[];
  /** HOW IT WEIGHED THIS — confidence factor breakdown. */
  factors: PipelineFactorVM[];
  /** HOW IT WEIGHED THIS — blended confidence (0-100), null when unknown. */
  confidence: number | null;
  /** HOW IT WEIGHED THIS — the per-pair auto-act bar (0-100). */
  threshold: number;
  /** DECISION — the decision pill. */
  decisionLabel: string;
  /** DECISION — plain-language note. */
  decisionNote: string;
}

/** Default auto-act bar when no pipeline call is available for a pending item. */
const DEFAULT_THRESHOLD = 75;

/** Inspector for a durable trace (history) row — already fully populated server-side. */
export function inspectorFromTrace(t: TraceEventVM): InspectorVM {
  return {
    tag: t.tag,
    time: t.time,
    title: t.title,
    signal: t.signal,
    evidence: t.evidence ?? [],
    factors: t.factors ?? [],
    confidence: t.confidence,
    threshold: t.threshold,
    decisionLabel: t.decisionLabel,
    decisionNote: t.decisionNote,
  };
}

/** Turn an alert's evidence map into short inspector chips. */
function evidenceChips(alert: AlertVM | undefined): string[] {
  if (!alert?.evidence) return [];
  return Object.entries(alert.evidence).map(([k, v]) => `${k}: ${v}`);
}

/**
 * Inspector for a pending (flagged) proposal: the signal comes from the alert
 * narrative (falling back to the proposal's one-liner), evidence from the alert,
 * and the factor breakdown + bar from the matching pipeline call (falling back
 * to the proposal's own confidence and a default bar).
 */
export function inspectorFromPending(
  p: QueueProposalVM,
  alert: AlertVM | undefined,
  call: PipelineCallVM | undefined,
): InspectorVM {
  return {
    tag: "NEEDS YOU",
    time: "now",
    title: p.title,
    signal: alert?.narrative ?? p.reasoning,
    evidence: evidenceChips(alert),
    factors: call?.factors ?? [],
    confidence: call?.confidence ?? p.confidence,
    threshold: call?.threshold ?? DEFAULT_THRESHOLD,
    decisionLabel: "NEEDS YOUR APPROVAL",
    decisionNote:
      "Calderyn is confident enough to suggest this, not yet to do it on its own.",
  };
}
