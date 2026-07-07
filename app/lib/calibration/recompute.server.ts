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
  calibrationPct, clampToDayAnchor, DETECTION_COLD, detectionFactor, HAS_EXECUTOR, pairConfidence, smooth,
} from "./confidence";
import { graduationVerdict } from "./graduation";
import { loadPairOutcomeTallies } from "./outcomes.server";
import { HAS_UNDO_BRANCH } from "./undo-branches";

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
  // Only detectors with a GRADUATABLE action participate in the weight universe.
  // An action with no executor (snooze_alert, and levers like issue_refund /
  // the free-ship kinds) scores 0 confidence forever, so including it would cap
  // the shop headline structurally below 100 and Autopilot could never graduate.
  const detectors = (Object.keys(DETECTOR_TO_ACTIONS) as DetectorId[]).filter((d) =>
    DETECTOR_TO_ACTIONS[d].some((a) => HAS_EXECUTOR.has(a)),
  );
  let totalDetectorWeight = 0;
  const detWeight: Record<string, number> = {};
  for (const d of detectors) {
    const w = (detectorFires[d] ?? 0) + SEED_FIRES;
    detWeight[d] = w;
    totalDetectorWeight += w;
  }
  for (const d of detectors) {
    // Only the graduatable actions carry weight — a non-executor action would
    // contribute weight at 0 confidence and drag the weighted average down.
    const actions = DETECTOR_TO_ACTIONS[d].filter((a) => HAS_EXECUTOR.has(a));
    if (actions.length === 0) continue;
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
  /** Skip peer-prior enrichment entirely.
   * Use on the synchronous approve/reject/loader paths where peer baselines
   * are deliberately not consulted (the queue and receipts use the same
   * peerless formula). The nightly cron leaves this unset. */
  skipPeerPrior?: boolean;
  /** Pre-fetched peer-prior map keyed `detector:action` → p50. The baselines
   * are shop-independent, so the nightly cron loads them ONCE per run (via
   * loadPeerPriors) and shares the map across every shop — without this, each
   * invocation fetches its own copy (still one bulk call, never per-pair). */
  peerPriors?: Map<string, number>;
  forceVisibleStep?: boolean;
}

/** Fetch every qualifying peer baseline in one call (shop-independent).
 * Best-effort: on any error returns an empty map — every pair falls back to
 * its static seed prior, same as a shop with no peers. */
export async function loadPeerPriors(sb: SupabaseClient): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { data, error } = await sb.rpc("action_pair_priors");
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ detector_id: string; action_kind: string; p50: unknown }>) {
      const p50 = Number(r.p50);
      if (Number.isFinite(p50)) map.set(`${r.detector_id}:${r.action_kind}`, p50);
    }
  } catch (err) {
    console.warn(
      `[recompute] peer-prior bulk read failed (static seeds this run): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return map;
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
      "detector_id, action_kind, alpha, beta, clean_approvals, consecutive_clean_approvals, consecutive_undos, merchant_disabled, graduation_threshold, net_positive_outcomes, last_outcome_sign",
    )
    .eq("shop_id", shopId);
  if (pairErr) throw pairErr;
  const pairMap = new Map<
    string,
    {
      alpha: number;
      beta: number;
      clean_approvals: number;
      consecutive_clean_approvals: number;
      consecutive_undos: number;
      merchant_disabled: boolean;
      graduation_threshold: number;
      net_positive_outcomes: number;
      last_outcome_sign: number;
    }
  >();
  for (const r of pairData ?? []) {
    pairMap.set(`${r.detector_id}:${r.action_kind}`, {
      alpha: Number(r.alpha ?? 0),
      beta: Number(r.beta ?? 0),
      clean_approvals: Number(r.clean_approvals ?? 0),
      consecutive_clean_approvals: Number(r.consecutive_clean_approvals ?? 0),
      consecutive_undos: Number(r.consecutive_undos ?? 0),
      merchant_disabled: Boolean(r.merchant_disabled),
      graduation_threshold: Number(r.graduation_threshold ?? 75),
      net_positive_outcomes: Number(r.net_positive_outcomes ?? 0),
      last_outcome_sign: Number(r.last_outcome_sign ?? 0),
    });
  }

  // Per-pair measured-outcome tallies from closed-window action_audit rewards.
  // Fail-safe: an empty map (read error / no data) means every pair sees 0
  // outcomes → no graduation on clicks alone, never a crash.
  const outcomeTallies = await loadPairOutcomeTallies(shopId, sb);

  // 2. 90-day detector stats — alert fires + detection-challenging rejects
  // (not_enough_data / other) as EXACT GROUP BY counts from one RPC (no row
  // cap, one round trip). FAIL-SOFT: if the RPC is unavailable (migration not
  // applied yet, statement timeout), fall back to the legacy row-listing reads
  // — exact pre-RPC behavior, including its explicit row bound — so a stats
  // hiccup can never freeze the headline or the pair cache for a shop.
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();
  const fires: Record<string, number> = {};
  const challenged: Record<string, number> = {};
  let statsViaRpc = false;
  try {
    const { data: statRows, error: statErr } = await sb.rpc("calibration_detector_stats", {
      p_shop_id: shopId,
      p_since: sinceIso,
    });
    if (statErr) throw new Error(statErr.message);
    for (const r of (statRows ?? []) as Array<{ detector_id: string; fired: unknown; challenged: unknown }>) {
      fires[r.detector_id] = Number(r.fired ?? 0);
      challenged[r.detector_id] = Number(r.challenged ?? 0);
    }
    statsViaRpc = true;
  } catch (err) {
    console.warn(
      `[recompute] detector-stats rpc failed (legacy reads this run): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!statsViaRpc) {
    // Legacy fallback. The fires read is load-bearing (throws on error, as
    // before); the challenge read stays best-effort. Both are bounded by the
    // PostgREST row cap — the documented truncation tradeoff of this path.
    const { data: alertRows, error: alertErr } = await sb
      .from("alerts")
      .select("detector_id")
      .eq("shop_id", shopId)
      .gte("first_seen_at", sinceIso)
      .limit(1000);
    if (alertErr) throw alertErr;
    for (const r of alertRows ?? []) fires[r.detector_id] = (fires[r.detector_id] ?? 0) + 1;
    try {
      const { data: challengeRows, error: chErr } = await sb
        .from("action_feedback")
        .select("detector_id")
        .eq("shop_id", shopId)
        .eq("decision", "reject")
        .in("reject_reason", ["not_enough_data", "other"])
        .gte("created_at", sinceIso)
        .limit(1000);
      if (chErr) throw new Error(chErr.message);
      for (const r of challengeRows ?? []) {
        challenged[r.detector_id] = (challenged[r.detector_id] ?? 0) + 1;
      }
    } catch (err) {
      console.warn(
        `[recompute] detection-challenge read failed (cold detection factors this run): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // Learned detection factor per detector — the same value feeds the nightly
  // AND sync paths (both run through here), so the queue/receipts read the
  // identical cached last_detection.
  const detectionByDetector: Record<string, number> = {};
  for (const d of Object.keys(fires)) {
    detectionByDetector[d] = detectionFactor(fires[d] ?? 0, challenged[d] ?? 0);
  }

  // Peer priors: shop-independent, so one bulk map serves every pair — either
  // the cron's shared map (opts.peerPriors) or a single fetch here. The
  // synchronous paths (skipPeerPrior) stay peerless by design.
  const peerPriors = opts?.skipPeerPrior
    ? new Map<string, number>()
    : opts?.peerPriors ?? (await loadPeerPriors(sb));

  // 3. conf per weighted pair; batch-cache graduated + last_conf on the
  // existing pair_calibration rows (single upsert instead of one UPDATE per
  // pair — the payload only contains rows read in step 1, so nothing is
  // created that did not already exist, and only the cache columns move;
  // alpha/beta are never in the payload).
  const weights = computeWeights(fires);
  const scored: { conf: number; weight: number }[] = [];
  const nowIso = new Date().toISOString();
  const cacheRows: Array<Record<string, unknown>> = [];
  for (const { detector, action, weight } of weights) {
    const key = `${detector}:${action}`;
    const peerRaw = peerPriors.get(key);
    const peerP50 = peerRaw == null || !Number.isFinite(peerRaw) ? null : peerRaw;
    const ev = pairMap.get(key);
    const detection = detectionByDetector[detector]; // undefined (no fires) → cold default
    const conf = pairConfidence(
      detector,
      action,
      { alpha: ev?.alpha ?? 0, beta: ev?.beta ?? 0 },
      peerP50,
      { detection, consecutiveCleanApprovals: ev?.consecutive_clean_approvals ?? 0 },
    );
    scored.push({ conf, weight });

    // Cache graduated + last_conf on the pair row (only when the row exists —
    // a cold-start pair has no row yet and there's nothing to update).
    // Probation/mute rules are NOT consulted here (they may change between runs);
    // the LIVE isGraduated check re-reads calibration_rule at exec time and is
    // the authoritative gate. onProbation=false is intentionally conservative:
    // a probation rule installed mid-day will be caught by the live gate.
    if (ev) {
      const tally = outcomeTallies.get(key);
      const netPositiveOutcomes = tally?.netPositive ?? 0;
      const lastOutcomeSign = tally?.lastSign ?? 0;
      const verdict = graduationVerdict({
        detectorId: detector,
        actionKind: action as ActionKind,
        lastConf: conf,
        gradThreshold: ev.graduation_threshold,
        cleanApprovals: ev.clean_approvals,
        consecutiveUndos: ev.consecutive_undos,
        merchantDisabled: ev.merchant_disabled,
        onProbation: false, // live gate is authoritative for mid-day rule changes
        hasUndoBranch: HAS_UNDO_BRANCH.has(action as ActionKind),
        netPositiveOutcomes,
        lastOutcomeSign,
      });
      cacheRows.push({
        shop_id: shopId,
        detector_id: detector,
        action_kind: action,
        graduated: verdict.graduated,
        last_conf: Math.round(conf),
        // Cache the learned detection factor so the queue, receipts, and the
        // live isGraduated gate read the SAME factor the recompute scored
        // with (they have no access to the alert/feedback windows). The
        // column is NOT NULL; a never-fired detector caches the cold factor
        // (the exact value the scorer above used for it).
        last_detection: detection ?? DETECTION_COLD,
        net_positive_outcomes: netPositiveOutcomes,
        last_outcome_sign: lastOutcomeSign,
        updated_at: nowIso,
      });
    }
  }

  if (cacheRows.length > 0) {
    // ONE round trip for the whole cache write. onConflict is the PK, and
    // every row in the payload was read in step 1, so this never inserts a
    // pair that did not exist — it is a batched UPDATE of the cache columns.
    const { error: cacheErr } = await sb
      .from("pair_calibration")
      .upsert(cacheRows, { onConflict: "shop_id,detector_id,action_kind" });
    if (cacheErr) {
      // Non-fatal: the nightly cache is best-effort; the live gate is authoritative.
      console.warn(`[recompute] pair_calibration cache upsert failed: ${cacheErr.message}`);
    }
  }

  const raw = calibrationPct(scored);

  // 4. smooth vs prior display, clamp to the day anchor, write back
  const { data: shopRow, error: shopErr } = await sb
    .from("shops")
    .select("calibration_pct, calibration_anchor_pct, calibration_anchor_date")
    .eq("id", shopId)
    .maybeSingle();
  if (shopErr) throw shopErr;
  const prev = shopRow?.calibration_pct == null ? null : Number(shopRow.calibration_pct);

  // Day anchor (I6): smooth() bounds a single run; the anchor bounds the whole
  // UTC day at ±5 now that the recompute runs hourly. The first run of a new
  // day pins the anchor to the day's opening display.
  const todayUtc = new Date().toISOString().slice(0, 10);
  const storedAnchorDate =
    shopRow?.calibration_anchor_date == null ? null : String(shopRow.calibration_anchor_date).slice(0, 10);
  const storedAnchorPct =
    shopRow?.calibration_anchor_pct == null ? null : Number(shopRow.calibration_anchor_pct);
  const anchorPct = storedAnchorDate === todayUtc && storedAnchorPct != null ? storedAnchorPct : prev;

  // The band includes prev so a merchant nudge that stepped outside it is
  // never reverted by a later passive run and a clamped value can never move
  // against the raw direction.
  let display = clampToDayAnchor(smooth(raw, prev), anchorPct, prev);
  // The merchant's own approve/reject must visibly move the needle — the ±1
  // nudge applies AFTER the day clamp on purpose (spec §9 I6 exemption).
  if (opts?.forceVisibleStep && prev != null && display === prev && raw !== prev) {
    display = raw > prev ? Math.min(100, prev + 1) : Math.max(0, prev - 1);
  }

  const { error: updErr } = await sb
    .from("shops")
    .update({
      calibration_pct: display,
      calibration_updated_at: new Date().toISOString(),
      calibration_anchor_pct: anchorPct ?? display,
      calibration_anchor_date: todayUtc,
    })
    .eq("id", shopId);
  if (updErr) throw updErr;

  return { shopId, pairs: scored.length, raw, display };
}
