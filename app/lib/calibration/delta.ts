// Pure trust-delta math + receipt shapes for the synchronous approve/reject
// path. NO I/O, NO .server imports — so it can be unit-tested without Supabase
// and imported by both approval.server.ts and reject.server.ts.
//
// The "delta" is the change in a (detector, action) pair's calibrated
// confidence caused by a single approve or reject: round(confAfter - confBefore).
// Both confidences are computed with peerP50 = null, matching the synchronous
// skipPeerPrior path the recompute job and Action Queue use (peer baselines are
// an async RPC we deliberately skip on the hot approve/reject path).

import type { ActionKind } from "../types";
import { pairConfidence } from "./confidence";

/** Beta counters for a pair. */
export interface PairEv {
  alpha: number;
  beta: number;
}

/** The before/after confidence change for a single approve or reject. */
export interface TrustDelta {
  /** Calibrated confidence (0-100) BEFORE the bump. */
  before: number;
  /** Calibrated confidence (0-100) AFTER the bump. */
  after: number;
  /** round(after - before). Positive on approve, ≤ 0 on reject. */
  delta: number;
}

/**
 * The "trust receipt" returned by recordApproval — everything the UI needs to
 * render the post-approve confirmation (confidence moved, getting close to
 * autopilot, just graduated).
 */
export interface ApproveReceipt {
  /** round(after - before) confidence points gained by this approval. */
  delta: number;
  before: number;
  after: number;
  /** clean_approvals counter AFTER the bump. */
  cleanApprovals: number;
  /** True if this action kind can ever graduate to autopilot (GRADUATABLE_V1). */
  graduatable: boolean;
  /** The pair's graduation_threshold AFTER the bump. */
  graduationThreshold: number;
  /** True iff this approval is the one that crossed the pair into graduated. */
  justGraduated: boolean;
}

/** The extra reject fields layered onto the existing { reflection } return. */
export interface RejectReceipt {
  delta: number;
  before: number;
  after: number;
  /** True if the reject reason produced a learned calibration_rule. */
  savedAsRule: boolean;
  /** Which rule kind was written, or null. */
  ruleKind: "pair_dollar_cap" | "pair_probation_until" | "muted_pair" | null;
}

/** Fail-safe zero receipt — returned whenever a read/compute fails. */
export const ZERO_APPROVE_RECEIPT: ApproveReceipt = {
  delta: 0,
  before: 0,
  after: 0,
  cleanApprovals: 0,
  graduatable: false,
  graduationThreshold: 0,
  justGraduated: false,
};

/** Fail-safe zero reject receipt (reflection is layered on by the caller). */
export const ZERO_REJECT_RECEIPT: RejectReceipt = {
  delta: 0,
  before: 0,
  after: 0,
  savedAsRule: false,
  ruleKind: null,
};

/**
 * The pair's calibrated confidence from its Beta counters, using peerP50=null
 * (the synchronous skipPeerPrior path). Single source so before/after always
 * use the identical formula.
 */
export function confFromEv(
  detectorId: string,
  actionKind: ActionKind,
  ev: PairEv,
): number {
  return pairConfidence(detectorId, actionKind, ev, null);
}

/**
 * Compute the before/after confidence change for a single bump, given the pair's
 * Beta counters read immediately before and after the RPC.
 */
export function trustDelta(
  detectorId: string,
  actionKind: ActionKind,
  before: PairEv,
  after: PairEv,
): TrustDelta {
  const b = confFromEv(detectorId, actionKind, before);
  const a = confFromEv(detectorId, actionKind, after);
  return { before: b, after: a, delta: Math.round(a - b) };
}
