// Nightly recompute of the shop calibration headline. Reads legal pairs +
// 90-day alert frequency + per-pair Beta counters, computes conf via the pure
// confidence module, weight-averages, smooths against the prior display, and
// writes shops.calibration_pct. No autonomy. See spec sections 2 + 9 (I6).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind, DetectorId } from "../types";
import { DETECTOR_TO_ACTIONS } from "../labels";
import {
  calibrationPct, pairConfidence, smooth,
} from "./confidence";

export interface RecomputeDeps {
  sb: SupabaseClient;
}

const RANK_DECAY = 0.6; // first action gets 60% of a detector's weight; rest split the remainder
const SEED_FIRES = 1; // every legal detector gets a baseline fire so new shops show a stable %
const WINDOW_DAYS = 90;

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

export async function recomputeShopCalibration(
  shopId: string,
  deps: RecomputeDeps,
): Promise<{ shopId: string; pairs: number; raw: number; display: number }> {
  const { sb } = deps;

  // 1. per-pair Beta counters (may be empty at cold start)
  const { data: pairData, error: pairErr } = await sb
    .from("pair_calibration")
    .select("detector_id, action_kind, alpha, beta")
    .eq("shop_id", shopId);
  if (pairErr) throw pairErr;
  const pairMap = new Map<string, { alpha: number; beta: number }>();
  for (const r of pairData ?? []) {
    pairMap.set(`${r.detector_id}:${r.action_kind}`, {
      alpha: Number(r.alpha ?? 0),
      beta: Number(r.beta ?? 0),
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

  // 3. conf per weighted pair
  const weights = computeWeights(fires);
  const scored: { conf: number; weight: number }[] = [];
  for (const { detector, action, weight } of weights) {
    const key = `${detector}:${action}`;
    let peerP50: number | null = null;
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
    const ev = pairMap.get(key);
    const conf = pairConfidence(detector, action, { alpha: ev?.alpha ?? 0, beta: ev?.beta ?? 0 }, peerP50);
    scored.push({ conf, weight });
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
