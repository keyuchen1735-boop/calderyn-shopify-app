// Nightly recompute of the shop calibration headline. Reads legal pairs +
// 90-day alert frequency + per-pair Beta counters, computes conf via the pure
// confidence module, weight-averages, smooths against the prior display, and
// writes shops.calibration_pct. Also caches pair_calibration.graduated and
// last_conf per pair (Slice 5, Task 2).
//
// Probation/mute rule notes: the nightly cache sets onProbation=false and
// merchantDisabled=pair.merchant_disabled only (not rules). The LIVE
// isGraduated check re-reads calibration_rule at exec time and is authoritative
// for any probation or mute rules added between nightly runs.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind, DetectorId } from "../types";
import { DETECTOR_TO_ACTIONS } from "../labels";
import {
  calibrationPct, pairConfidence, smooth,
} from "./confidence";
import { graduationVerdict } from "./graduation";

export interface RecomputeDeps {
  sb: SupabaseClient;
}

const RANK_DECAY = 0.6; // first action gets 60% of a detector's weight; rest split the remainder
const SEED_FIRES = 1; // every legal detector gets a baseline fire so new shops show a stable %
const WINDOW_DAYS = 90;

/** Action kinds with a working undo branch (mirrors graduation.server.ts HAS_UNDO_BRANCH). */
const HAS_UNDO_BRANCH: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "reallocate_budget",
  "reallocate_inventory",
]);

export function computeWeights(
  detectorFires: Record<string, number>,
): { detector: string; action: ActionKind; weight: number }[] {
  const out: { detector: string; action: ActionKind; weight: number }[] = [];
  const detectors = Object.keys(DETECTOR_TO_ACTIONS) as DetectorId[];
  let totalDetectorWeight = 0;
  const detWeight: Record<string, number> = {};
  for (const d of detectors) {
    const w = (detectorFires[d] ?? 0) + SEED_FIRES;
    detWeight[d] = w;
    totalDetectorWeight += w;
  }
  for (const d of detectors) {
    const actions = DETECTOR_TO_ACTIONS[d];
    const dShare = detWeight[d] / totalDetectorWeight;
    actions.forEach((action, i) => {
      // rank-decay: first action RANK_DECAY of the share, remainder split evenly
      const share =
        actions.length === 1
          ? 1
          : i === 0
            ? RANK_DECAY
            : (1 - RANK_DECAY) / (actions.length - 1);
      out.push({ detector: d, action, weight: dShare * share });
    });
  }
  return out;
}

export interface RecomputeOpts {
  /** Skip the per-pair `action_pair_prior` RPC call.
   * Use on the synchronous first-load path (loader lazy-compute) where peer
   * baselines are not yet populated — avoids N+1 RPCs at request time. The
   * nightly cron leaves this unset to keep peer-prior enrichment intact. */
  skipPeerPrior?: boolean;
}

export async function recomputeShopCalibration(
  shopId: string,
  deps: RecomputeDeps,
  opts?: RecomputeOpts,
): Promise<{ shopId: string; pairs: number; raw: number; display: number }> {
  const { sb } = deps;

  // 1. per-pair Beta counters + graduation fields (may be empty at cold start)
  const { data: pairData, error: pairErr } = await sb
    .from("pair_calibration")
    .select(
      "detector_id, action_kind, alpha, beta, clean_approvals, consecutive_undos, merchant_disabled, graduation_threshold",
    )
    .eq("shop_id", shopId);
  if (pairErr) throw pairErr;
  const pairMap = new Map<
    string,
    {
      alpha: number;
      beta: number;
      clean_approvals: number;
      consecutive_undos: number;
      merchant_disabled: boolean;
      graduation_threshold: number;
    }
  >();
  for (const r of pairData ?? []) {
    pairMap.set(`${r.detector_id}:${r.action_kind}`, {
      alpha: Number(r.alpha ?? 0),
      beta: Number(r.beta ?? 0),
      clean_approvals: Number(r.clean_approvals ?? 0),
      consecutive_undos: Number(r.consecutive_undos ?? 0),
      merchant_disabled: Boolean(r.merchant_disabled),
      graduation_threshold: Number(r.graduation_threshold ?? 75),
    });
  }

  // 2. 90-day detector fire counts
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();
  const { data: alertRows, error: alertErr } = await sb
    .from("alerts")
    .select("detector_id")
    .eq("shop_id", shopId)
    .gte("created_at", sinceIso);
  if (alertErr) throw alertErr;
  const fires: Record<string, number> = {};
  for (const r of alertRows ?? []) fires[r.detector_id] = (fires[r.detector_id] ?? 0) + 1;

  // 3. conf per weighted pair; cache graduated + last_conf on pair_calibration rows
  const weights = computeWeights(fires);
  const scored: { conf: number; weight: number }[] = [];
  for (const { detector, action, weight } of weights) {
    const key = `${detector}:${action}`;
    let peerP50: number | null = null;
    if (!opts?.skipPeerPrior) {
      try {
        const { data } = await sb.rpc("action_pair_prior", {
          p_shop_id: shopId,
          p_detector_id: detector,
          p_action_kind: action,
        });
        peerP50 = data == null ? null : Number(data);
      } catch {
        peerP50 = null; // peer baselines optional; fall back to static seed
      }
    }
    // skipPeerPrior=true: peerP50 stays null → static seed used (same outcome
    // as a failed RPC, but without the network round-trip per pair).
    const ev = pairMap.get(key);
    const conf = pairConfidence(detector, action, { alpha: ev?.alpha ?? 0, beta: ev?.beta ?? 0 }, peerP50);
    scored.push({ conf, weight });

    // Cache graduated + last_conf on the pair row (only when the row exists —
    // a cold-start pair has no row yet and there's nothing to update).
    // Probation/mute rules are NOT consulted here (they may change between runs);
    // the LIVE isGraduated check re-reads calibration_rule at exec time and is
    // the authoritative gate. onProbation=false is intentionally conservative:
    // a probation rule installed mid-day will be caught by the live gate.
    if (ev) {
      const verdict = graduationVerdict({
        actionKind: action as ActionKind,
        lastConf: conf,
        gradThreshold: ev.graduation_threshold,
        cleanApprovals: ev.clean_approvals,
        consecutiveUndos: ev.consecutive_undos,
        merchantDisabled: ev.merchant_disabled,
        onProbation: false, // live gate is authoritative for mid-day rule changes
        hasUndoBranch: HAS_UNDO_BRANCH.has(action as ActionKind),
      });
      const { error: pairUpdErr } = await sb
        .from("pair_calibration")
        .update({ graduated: verdict.graduated, last_conf: Math.round(conf), updated_at: new Date().toISOString() })
        .eq("shop_id", shopId)
        .eq("detector_id", detector)
        .eq("action_kind", action);
      if (pairUpdErr) {
        // Non-fatal: the nightly cache is best-effort; the live gate is authoritative.
        console.warn(`[recompute] pair_calibration update failed for ${detector}:${action}: ${pairUpdErr.message}`);
      }
    }
  }

  const raw = calibrationPct(scored);

  // 4. smooth vs prior display, write back
  const { data: shopRow, error: shopErr } = await sb
    .from("shops")
    .select("calibration_pct")
    .eq("id", shopId)
    .maybeSingle();
  if (shopErr) throw shopErr;
  const prev = shopRow?.calibration_pct == null ? null : Number(shopRow.calibration_pct);
  const display = smooth(raw, prev);

  const { error: updErr } = await sb
    .from("shops")
    .update({ calibration_pct: display, calibration_updated_at: new Date().toISOString() })
    .eq("id", shopId);
  if (updErr) throw updErr;

  return { shopId, pairs: scored.length, raw, display };
}
