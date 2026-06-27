// Browser-safe view-model contract for the Live Engine page. Pure types, no
// imports of any `.server` module, so the dashboard client (browser-only) and
// the embedded route can both share the exact shape produced by the server-side
// buildLiveEnginePageData (live-engine-page.server.ts re-exports these).
import type { ActionKind } from "../types";

export type TraceTag = "AUTO" | "APPROVED" | "UNDONE" | "BLOCKED";
export type PredictionTone = "warn" | "down" | "geo" | "up";

export interface PipelineFactorVM {
  key: string;
  /** Plain-language factor label, e.g. "Your track record". */
  label: string;
  /** 0-100 strength. */
  value: number;
  /** 0-1 share of the blended confidence. */
  weight: number;
}

export interface PipelineCallVM {
  detectorId: string;
  actionKind: ActionKind;
  title: string;
  context: string;
  factors: PipelineFactorVM[];
  /** Surfaced confidence, 0-100. */
  confidence: number;
  /** Real per-pair auto-act bar, 0-100. */
  threshold: number;
  /** confidence >= threshold — Calderyn handled (or would handle) it on its own. */
  auto: boolean;
}

export interface TraceEventVM {
  id: string;
  tag: TraceTag;
  detectorId: string;
  actionKind: ActionKind;
  /** Row headline, e.g. "Paused Summit Tee retarget". */
  text: string;
  /** Signed impact in cents (negative on reversals); 0 when none. */
  moneyCents: number;
  /** HH:MM clock for the row. */
  time: string;
  /** Relative age, e.g. "12 min ago". */
  rel: string;
  // ----- inspector detail -----
  title: string;
  signal: string;
  evidence: string[];
  /** Confidence breakdown for this pair, or null when there's no pair to weigh. */
  factors: PipelineFactorVM[] | null;
  confidence: number | null;
  threshold: number;
  decisionLabel: string;
  decisionNote: string;
}

export interface PredictionVM {
  kind: "stockout" | "alert" | "campaign";
  text: string;
  detail: string;
  tone: PredictionTone;
}

export interface LiveEngineFeatureVM {
  detectorId: string;
  actionKind: ActionKind;
  /** Action label, e.g. "Pause campaign". */
  name: string;
  /** Detector label, e.g. "Campaign is losing money". */
  watching: string;
  enabled: boolean;
  /** Unlocked + not enabled + not muted + has a track record => show a
   *  "Ready to turn on" recommendation (Slice C). */
  recommended: boolean;
  moneyCents: number;
  actions: number;
  lastAt: string | null;
  /** "last acted 12 min ago" | "no actions yet". */
  lastText: string;
  /** Two-bar graduation progress (design 2026-06-26 §2.1). */
  approvals: number;
  approvalsNeeded: number;
  outcomes: number;
  outcomesNeeded: number;
  proven: boolean;
}

export interface LiveEnginePageData {
  autopilotEnabled: boolean;
  moneyProtectedWeekCents: number;
  features: LiveEngineFeatureVM[];
  pipeline: PipelineCallVM[];
  trace: TraceEventVM[];
  predictions: PredictionVM[];
  calibrationPct: number | null;
  nearGraduation: number;
}
