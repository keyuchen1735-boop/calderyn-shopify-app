// Organic-action learning: Calderyn learns from what the merchant does
// OUTSIDE it (spec follow-on to §7 — the merchant's own platform actions are
// the richest untapped signal). Fully deterministic; runs nightly per shop
// from cron.calibration-recompute BEFORE the confidence recompute so the
// night's headline already reflects it.
//
// Two signals, both fail-safe (any doubt → no signal):
//
//  1. IMPLICIT APPROVAL — an open alert recommends pause_campaign, no action
//     was executed through Calderyn for that alert, and the campaign is now
//     paused on the platform (fresh sync required). The merchant did the very
//     thing Calderyn suggested — worth HALF an explicit click (alpha +0.5 via
//     calibration_record_implicit_approval; clean_approvals untouched, so the
//     explicit-approval graduation bars are unaffected). The alert is then
//     acknowledged: the problem is handled, it leaves the queue, and the
//     open→acknowledged transition is what makes the credit exactly-once.
//
//  2. OUT-OF-BAND REVERSAL — autopilot paused a campaign, the merchant did
//     NOT use Calderyn's Undo, and the campaign is active again on the
//     platform (fresh sync required). That is a real undo in spirit — the
//     strongest distrust signal — so it feeds the SAME
//     calibration_record_undo(p_autonomous=true) path (+1.5 beta,
//     consecutive_undos+1, streak reset), exactly-once per reversed audit via
//     an action_feedback 'reversal' ledger row (the failure-ledger pattern).
//
// Sync freshness: platform state older than ORGANIC_FRESH_MS proves nothing —
// stale rows produce NO signal in either direction.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DetectorId } from "../types";
import { recommendedAction } from "../labels";
import { isUuid } from "../ids";
import {
  ACTIVE_CAMPAIGN_STATUSES,
  INACTIVE_CAMPAIGN_STATUSES,
} from "./preconditions.server";

export const ORGANIC_FRESH_MS = 24 * 60 * 60 * 1000; // platform sync ≤ 24h old
export const REVERSAL_WINDOW_DAYS = 7; // how far back autonomous pauses are checked
export const IMPLICIT_ALPHA = 0.5; // half an explicit approval
/** How far back ANY Calderyn pause on the campaign disqualifies "organic". */
export const DISQUALIFY_WINDOW_DAYS = 30;
/** More qualifying organic pauses than this in ONE sweep looks like a bulk /
 * seasonal pause (holiday shutdown), not per-suggestion agreement: credit and
 * acknowledge NOTHING that night. */
export const MASS_PAUSE_LIMIT = 3;

export interface OrganicSweepSummary {
  implicitApprovals: number;
  reversals: number;
  errors: string[];
}

interface CampaignRow {
  id: string;
  status: string;
  last_synced_at: string | null;
}

const freshEnough = (row: CampaignRow, nowMs: number): boolean => {
  const syncedAt = row.last_synced_at ? Date.parse(row.last_synced_at) : NaN;
  return Number.isFinite(syncedAt) && nowMs - syncedAt <= ORGANIC_FRESH_MS;
};

/** Load campaign state for a set of ids in one query; returns a map by id. */
async function loadCampaigns(
  sb: SupabaseClient,
  ids: string[],
): Promise<Map<string, CampaignRow>> {
  const map = new Map<string, CampaignRow>();
  if (ids.length === 0) return map;
  const { data, error } = await sb
    .from("ad_campaign_dim")
    .select("id, status, last_synced_at")
    .in("id", [...new Set(ids)]);
  if (error) throw new Error(`campaign read failed: ${error.message}`);
  for (const r of data ?? []) {
    map.set(String(r.id), {
      id: String(r.id),
      status: String(r.status ?? ""),
      last_synced_at: r.last_synced_at == null ? null : String(r.last_synced_at),
    });
  }
  return map;
}

/**
 * Signal 1 — implicit approvals of open pause suggestions the merchant
 * fulfilled on the platform themselves.
 */
async function sweepImplicitPauses(
  shopId: string,
  sb: SupabaseClient,
  nowMs: number,
  summary: OrganicSweepSummary,
): Promise<void> {
  // Open alerts with a resolvable campaign, from the same view autopilot uses.
  const { data: rows, error } = await sb
    .from("v_autopilot_candidates")
    .select("alert_id, detector_id, campaign_id")
    .eq("shop_id", shopId)
    .not("campaign_id", "is", null)
    .limit(200);
  if (error) throw new Error(`candidate read failed: ${error.message}`);

  const pauseCands = (rows ?? [])
    .map((r) => ({
      alertId: String(r.alert_id),
      detectorId: String(r.detector_id),
      campaignId: String(r.campaign_id),
    }))
    .filter(
      (c) =>
        isUuid(c.campaignId) &&
        recommendedAction(c.detectorId as DetectorId, { hasCampaign: true }) ===
          "pause_campaign",
    );
  if (pauseCands.length === 0) return;

  const campaigns = await loadCampaigns(
    sb,
    pauseCands.map((c) => c.campaignId),
  );

  // Phase 1 — qualify WITHOUT side effects, so a bulk/seasonal pause can be
  // recognized and skipped as a whole before anything is credited or acked.
  const qualified: typeof pauseCands = [];
  const disqualifySinceIso = new Date(nowMs - DISQUALIFY_WINDOW_DAYS * 86400_000).toISOString();
  for (const cand of pauseCands) {
    try {
      const campaign = campaigns.get(cand.campaignId);
      // Fail-safe: unknown campaign, stale sync, or still-active → no signal.
      if (!campaign || !freshEnough(campaign, nowMs)) continue;
      if (!INACTIVE_CAMPAIGN_STATUSES.has(campaign.status)) continue;

      // Any pause executed THROUGH Calderyn on this CAMPAIGN recently — for
      // any alert (a second open alert on the same campaign) or with no alert
      // at all (the Campaigns page writes alert_id null) — means the paused
      // state is Calderyn's own work, not an organic merchant action.
      const { data: audits, error: auditErr } = await sb
        .from("action_audit")
        .select("id")
        .eq("shop_id", shopId)
        .eq("action_kind", "pause_campaign")
        .eq("outcome", "succeeded")
        .eq("params->>campaign_id", cand.campaignId)
        .gte("created_at", disqualifySinceIso)
        .limit(1);
      if (auditErr) throw new Error(`audit read failed: ${auditErr.message}`);
      if ((audits ?? []).length > 0) continue;

      qualified.push(cand);
    } catch (err) {
      summary.errors.push(
        `implicit ${cand.alertId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (qualified.length === 0) return;
  if (qualified.length > MASS_PAUSE_LIMIT) {
    // A holiday-style bulk pause is agreement with nothing in particular:
    // no credits, no acks — the alerts stay open and visible (rule 12: the
    // skip is surfaced in the cron log, not silent).
    console.info(
      `[organic] shop ${shopId}: ${qualified.length} paused suggestions in one sweep (> ${MASS_PAUSE_LIMIT}) — treating as bulk pause, no credits`,
    );
    return;
  }

  // Phase 2 — side effects per qualified candidate.
  for (const cand of qualified) {
    try {
      // At-most-once: the open→acknowledged transition is the dedup. Only the
      // row we actually flip counts; a concurrent sweep flipping it first
      // matches zero rows and credits nothing.
      const { data: flipped, error: ackErr } = await sb
        .from("alerts")
        .update({ status: "acknowledged" })
        .eq("shop_id", shopId)
        .eq("id", cand.alertId)
        .eq("status", "open")
        .select("id");
      if (ackErr) throw new Error(`alert ack failed: ${ackErr.message}`);
      if ((flipped ?? []).length === 0) continue;

      const { error: rpcErr } = await sb.rpc("calibration_record_implicit_approval", {
        p_shop_id: shopId,
        p_detector_id: cand.detectorId,
        p_action_kind: "pause_campaign",
        p_alpha_delta: IMPLICIT_ALPHA,
      });
      if (rpcErr) {
        // Compensate: the ack was OURS a moment ago — revert it so the alert
        // stays visible and the credit can retry on a later night, instead of
        // silently vanishing from the queue with no signal recorded.
        await sb
          .from("alerts")
          .update({ status: "open" })
          .eq("shop_id", shopId)
          .eq("id", cand.alertId)
          .eq("status", "acknowledged");
        throw new Error(`implicit-approval rpc failed: ${rpcErr.message}`);
      }

      // Audit trail (display/analytics only — the ack above is the dedup).
      const { error: fbErr } = await sb.from("action_feedback").insert({
        shop_id: shopId,
        alert_id: cand.alertId,
        detector_id: cand.detectorId,
        action_kind: "pause_campaign",
        decision: "approve",
        note: "organic: merchant paused the campaign on the platform",
      });
      if (fbErr) {
        console.error(`[organic] feedback insert failed for ${cand.alertId}: ${fbErr.message}`);
      }

      summary.implicitApprovals += 1;
    } catch (err) {
      summary.errors.push(
        `implicit ${cand.alertId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Signal 2 — out-of-band reversals of autonomous pauses (the merchant
 * re-activated the campaign on the platform without Calderyn's Undo).
 */
async function sweepOutOfBandReversals(
  shopId: string,
  sb: SupabaseClient,
  nowMs: number,
  summary: OrganicSweepSummary,
): Promise<void> {
  const sinceIso = new Date(nowMs - REVERSAL_WINDOW_DAYS * 86400_000).toISOString();
  const { data: audits, error } = await sb
    .from("action_audit")
    .select("id, alert_id, params, created_at")
    .eq("shop_id", shopId)
    .eq("actor_user_id", "autopilot")
    .eq("action_kind", "pause_campaign")
    .eq("outcome", "succeeded")
    .is("undo_of", null)
    .gte("created_at", sinceIso)
    .limit(200);
  if (error) throw new Error(`autonomous-audit read failed: ${error.message}`);

  const pauses = (audits ?? [])
    .map((a) => ({
      auditId: String(a.id),
      alertId: a.alert_id == null ? null : String(a.alert_id),
      campaignId: String(
        ((a.params ?? {}) as Record<string, unknown>).campaign_id ?? "",
      ),
      createdAt: String(a.created_at ?? ""),
    }))
    // campaignId is interpolated into a PostgREST .or() filter below — refuse
    // anything that is not a plain uuid rather than risk corrupting the
    // expression (same guard as checkGuardrails).
    .filter((a) => isUuid(a.campaignId) && a.alertId !== null);
  if (pauses.length === 0) return;

  const campaigns = await loadCampaigns(
    sb,
    pauses.map((p) => p.campaignId),
  );

  for (const pause of pauses) {
    try {
      const campaign = campaigns.get(pause.campaignId);
      // Fail-safe: unknown campaign, stale sync, or still-paused → no signal.
      if (!campaign || !freshEnough(campaign, nowMs)) continue;
      if (!ACTIVE_CAMPAIGN_STATUSES.has(campaign.status)) continue;
      // A re-activation only counts once the platform state is NEWER than the
      // pause itself (otherwise we may be reading the pre-pause sync).
      const pausedAtMs = Date.parse(pause.createdAt);
      const syncedAtMs = Date.parse(campaign.last_synced_at ?? "");
      if (!Number.isFinite(pausedAtMs) || !Number.isFinite(syncedAtMs)) continue;
      if (syncedAtMs <= pausedAtMs) continue;

      // The merchant may have reversed it THROUGH Calderyn: an undo row
      // (undo_of = this audit) or a later Calderyn resume for the campaign
      // means this is already learned through the normal paths.
      const { data: reversedThroughUs, error: revErr } = await sb
        .from("action_audit")
        .select("id")
        .eq("shop_id", shopId)
        .or(
          `undo_of.eq.${pause.auditId},and(action_kind.eq.resume_campaign,params->>campaign_id.eq.${pause.campaignId})`,
        )
        .gte("created_at", pause.createdAt)
        .limit(1);
      if (revErr) throw new Error(`reversal-audit read failed: ${revErr.message}`);
      if ((reversedThroughUs ?? []).length > 0) continue;

      // The pair to demote: the detector comes from the alert that drove the
      // autonomous pause. No alert row → no pair to learn on → skip (the
      // ledger stays unwritten, so a later night can retry).
      const { data: alertRow, error: alertErr } = await sb
        .from("alerts")
        .select("detector_id")
        .eq("shop_id", shopId)
        .eq("id", pause.alertId)
        .maybeSingle();
      if (alertErr) throw new Error(`alert read failed: ${alertErr.message}`);
      const detectorId = alertRow?.detector_id == null ? null : String(alertRow.detector_id);
      if (!detectorId) continue;

      // Exactly-once per reversed audit: the 'reversal' ledger row.
      const { data: ledger, error: ledgerErr } = await sb
        .from("action_feedback")
        .upsert(
          {
            shop_id: shopId,
            audit_id: pause.auditId,
            alert_id: pause.alertId,
            detector_id: detectorId,
            action_kind: "pause_campaign",
            decision: "reversal",
            note: "organic: merchant re-activated the campaign on the platform",
          },
          { onConflict: "shop_id,audit_id,decision", ignoreDuplicates: true },
        )
        .select("id");
      if (ledgerErr) throw new Error(`reversal ledger failed: ${ledgerErr.message}`);
      if ((ledger ?? []).length === 0) continue; // already recorded

      const { error: undoErr } = await sb.rpc("calibration_record_undo", {
        p_shop_id: shopId,
        p_detector_id: detectorId,
        p_action_kind: "pause_campaign",
        p_autonomous: true,
      });
      if (undoErr) {
        // Compensate: a failed bump must not leave the ledger row behind — the
        // nightly sweep is this signal's ONLY producer, so an orphaned row
        // would dedup every future night and the strongest distrust signal
        // would be permanently lost. Best-effort delete, then surface.
        const ledgerId = String((ledger ?? [])[0]?.id ?? "");
        if (ledgerId) {
          await sb.from("action_feedback").delete().eq("shop_id", shopId).eq("id", ledgerId);
        }
        throw new Error(`reversal undo rpc failed: ${undoErr.message}`);
      }

      summary.reversals += 1;
    } catch (err) {
      summary.errors.push(
        `reversal ${pause.auditId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Run both organic-signal sweeps for one shop. Never throws — per-signal
 * failures are collected into the summary so the nightly cron keeps draining
 * shops (a broken sweep must never block the confidence recompute).
 */
export async function sweepOrganicSignals(
  shopId: string,
  sb: SupabaseClient,
  nowMs = Date.now(),
): Promise<OrganicSweepSummary> {
  const summary: OrganicSweepSummary = { implicitApprovals: 0, reversals: 0, errors: [] };
  try {
    await sweepImplicitPauses(shopId, sb, nowMs, summary);
  } catch (err) {
    summary.errors.push(`implicit sweep: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await sweepOutOfBandReversals(shopId, sb, nowMs, summary);
  } catch (err) {
    summary.errors.push(`reversal sweep: ${err instanceof Error ? err.message : String(err)}`);
  }
  return summary;
}
