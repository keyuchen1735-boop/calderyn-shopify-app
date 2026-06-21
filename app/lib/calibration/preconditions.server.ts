// Freshness + live precondition re-check (I4) and the stockout pause allowlist (I10).
//
// MONEY-PATH INVARIANTS (never relax):
//   - Every function is fail-safe: a thrown DB read or a missing datum returns
//     ok:false. An ok:false means the action is SKIPPED (queued), NEVER executed.
//   - Never default to allowing an action when a required datum is unavailable.
//   - Called after graduation + guardrails pass and BEFORE executeAction.
//
// Schema reality (confirmed prod DB 2026-06-21):
//   ad_campaign_dim: id, shop_id, status (text), daily_budget_cents, last_synced_at
//   inventory_level_fact: sku_id, location_id, available (int), observed_at, source_version
//   sku_dim: id, shop_id, external_id, title, sku — NO inventory_policy, NO inventory_tracked
//
// I10 FAIL-SAFE NOTE: `inventory_policy` and inventory-tracking status are NOT
// synced to any Supabase table in the current schema. These are required preconditions
// for the stockout-pause allowlist (deny-policy = not a pre-order/backorder; tracking on
// = not a dropship/digital/untracked SKU). Because we CANNOT verify them, stockoutPauseAllowed
// always returns ok:false with reason "inventory_policy_not_available". This is the correct
// safe default: when in doubt, queue for manual review instead of acting autonomously.
// When inventory_policy is added to sku_dim (future migration), remove the fail-safe
// and implement the full gate.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";
import type { Candidate } from "../actions/autopilot-targeting.server";

/** Staleness thresholds */
const STOCK_FRESH_MS = 60 * 60 * 1000; // 60 minutes
const SPEND_FRESH_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Campaign statuses that mean "actively running and spending". */
const ACTIVE_CAMPAIGN_STATUSES = new Set([
  "active",
  "ACTIVE",
  "enabled",
  "ENABLED",
]);

/** Campaign statuses that mean "paused or ended — precondition already gone". */
const INACTIVE_CAMPAIGN_STATUSES = new Set([
  "paused",
  "PAUSED",
  "ended",
  "ENDED",
  "removed",
  "REMOVED",
  "deleted",
  "DELETED",
  "archived",
  "ARCHIVED",
]);

interface PreconditionResult {
  ok: boolean;
  reason?: string;
}

interface PreconditionFreshInput {
  kind: ActionKind;
  candidate: Candidate;
  sb: SupabaseClient;
  nowMs: number;
}

interface StockoutAllowedInput {
  shopId: string;
  /** The raw alert row (from alerts table — entity_ref carries {sku_id, sku}). */
  alert: {
    id: string;
    detector_id: string;
    entity_ref: Record<string, unknown>;
  };
  sb: SupabaseClient;
}

// ---------------------------------------------------------------------------
// preconditionFresh (I4)
// ---------------------------------------------------------------------------

/**
 * Re-read LIVE campaign state and abort if the precondition no longer holds.
 *
 * pause_campaign:
 *   - Campaign must be ACTIVE (not paused/ended already).
 *   - Sync data must be fresh (last_synced_at <= 24h ago for spend facts).
 *
 * reduce_campaign_budget:
 *   - Live daily_budget_cents must still match the snapshot in the candidate
 *     (daily_budget_cents from v_autopilot_candidates at alert-evaluation time).
 *     If live < snapshot: already reduced by someone else → abort.
 *   - Sync data must be fresh (<= 24h).
 *
 * Fail-safe: any DB error or missing row returns ok:false.
 * Never throws — callers rely on a returned result, not exception catching.
 */
export async function preconditionFresh(input: PreconditionFreshInput): Promise<PreconditionResult> {
  const { kind, candidate, sb, nowMs } = input;
  try {
    // Re-read the live campaign from ad_campaign_dim.
    const { data: campaign, error } = await sb
      .from("ad_campaign_dim")
      .select("id, status, daily_budget_cents, last_synced_at")
      .eq("id", candidate.campaign_id)
      .maybeSingle();

    if (error) {
      console.error(`[preconditions] DB error reading campaign ${candidate.campaign_id}: ${error.message}`);
      return { ok: false, reason: `db_error: ${error.message}` };
    }

    if (!campaign) {
      return { ok: false, reason: "precondition_stale: campaign not found" };
    }

    // Staleness check: last_synced_at must be within 24h (spend facts window).
    const syncedAt = campaign.last_synced_at ? new Date(campaign.last_synced_at).getTime() : 0;
    if (nowMs - syncedAt > SPEND_FRESH_MS) {
      return {
        ok: false,
        reason: `stale_facts: campaign last synced ${Math.round((nowMs - syncedAt) / 3600000)}h ago (> 24h threshold)`,
      };
    }

    if (kind === "pause_campaign") {
      // The precondition: campaign must still be active (not already paused/ended).
      const isActive = ACTIVE_CAMPAIGN_STATUSES.has(campaign.status);
      const isInactive = INACTIVE_CAMPAIGN_STATUSES.has(campaign.status);

      if (isInactive || !isActive) {
        return {
          ok: false,
          reason: `precondition_stale: not active (status=${campaign.status})`,
        };
      }
      return { ok: true };
    }

    if (kind === "reduce_campaign_budget") {
      // The precondition: live daily_budget_cents must still match the snapshot.
      // If live < snapshot, someone already cut it — abort to avoid double-cutting.
      // If candidate.daily_budget_cents is null, we have no baseline → fail-safe.
      if (candidate.daily_budget_cents == null) {
        return { ok: false, reason: "precondition_stale: budget already at/below target (no snapshot)" };
      }

      const liveBudget = campaign.daily_budget_cents ?? 0;
      const snapshotBudget = candidate.daily_budget_cents;

      if (liveBudget < snapshotBudget) {
        return {
          ok: false,
          reason: `precondition_stale: budget already at/below target (live=${liveBudget}c < snapshot=${snapshotBudget}c)`,
        };
      }
      return { ok: true };
    }

    // For any other kind not explicitly handled, fail-safe.
    return { ok: false, reason: `precondition_fresh: unsupported kind ${kind}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preconditions] preconditionFresh threw: ${msg}`);
    return { ok: false, reason: `threw: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// stockoutPauseAllowed (I10)
// ---------------------------------------------------------------------------

/**
 * Stockout pause allowlist gate (I10).
 *
 * Returns ok:true ONLY when ALL of the following hold:
 *   1. sku_id is present in the alert's entity_ref.
 *   2. inventory_policy = 'deny' (NOT 'continue') — never auto-pause a pre-order/
 *      backorder product.  [FAIL-SAFE: column not in schema → ok:false]
 *   3. Inventory tracking is ON — skip dropship/digital/untracked.
 *      [FAIL-SAFE: column not in schema → ok:false]
 *   4. ALL inventory rows for this SKU show available = 0 (fully out of stock).
 *   5. The latest stock observation is fresh (<= 60 min old).
 *   6. The campaign is still actively spending (status = ACTIVE/ENABLED).
 *
 * When any condition cannot be verified (data missing from schema), returns ok:false.
 * This is the intentional safe default: "when unsure, queue for human review."
 *
 * SCHEMA GAP (documented): inventory_policy and inventory_tracked are NOT present in
 * sku_dim as of 2026-06-21. This function ALWAYS returns ok:false with reason
 * "inventory_policy_not_available" until those columns are added. This prevents ANY
 * autonomous stockout-pause, which is the correct conservative default.
 */
export async function stockoutPauseAllowed(input: StockoutAllowedInput): Promise<PreconditionResult> {
  try {
    // Gate 1: sku_id must be in entity_ref.
    const entityRef = input.alert.entity_ref ?? {};
    const skuId = typeof entityRef.sku_id === "string" ? entityRef.sku_id : null;
    if (!skuId) {
      return { ok: false, reason: "sku_id_missing: entity_ref has no sku_id" };
    }

    // Gate 2 + 3: inventory_policy and inventory_tracked NOT in schema.
    // FAIL-SAFE: cannot verify these preconditions → ok:false.
    //
    // When sku_dim gains these columns, replace this block with:
    //   const { data: sku } = await input.sb.from("sku_dim")
    //     .select("inventory_policy, inventory_tracked")
    //     .eq("shop_id", input.shopId)
    //     .eq("id", skuId)
    //     .maybeSingle();
    //   if (!sku || sku.inventory_policy !== 'deny') return { ok:false, reason:"inventory_policy_not_deny" }
    //   if (!sku.inventory_tracked) return { ok:false, reason:"inventory_tracking_off" }
    //   const stockCheck = await _checkStockFreshAndEmpty(input.shopId, skuId, input.sb, Date.now());
    //   if (!stockCheck.ok) return stockCheck;
    //   (then verify campaign still actively spending via input.sb / ad_campaign_dim)
    //
    // Until then, every stockout-pause is queued for human review (fail-safe).
    return {
      ok: false,
      reason: "inventory_policy_not_available: sku_dim.inventory_policy column not in schema — stockout-pause queued for manual review",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preconditions] stockoutPauseAllowed threw: ${msg}`);
    return { ok: false, reason: `threw: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (reachable once schema gap is resolved)
// ---------------------------------------------------------------------------

/**
 * Check that ALL inventory_level_fact rows for a SKU show available=0
 * AND the latest observation is fresh (<= 60 min).
 * Returns ok:false if any row shows available>0, no rows, or stale facts.
 *
 * @internal — not exported; called by stockoutPauseAllowed once inventory_policy
 * is available in sku_dim.
 */
export async function _checkStockFreshAndEmpty(
  shopId: string,
  skuId: string,
  sb: SupabaseClient,
  nowMs: number,
): Promise<PreconditionResult> {
  const { data: rows, error } = await sb
    .from("inventory_level_fact")
    .select("location_id, available, observed_at")
    .eq("shop_id", shopId)
    .eq("sku_id", skuId);

  if (error) {
    return { ok: false, reason: `db_error reading inventory: ${error.message}` };
  }

  if (!rows || rows.length === 0) {
    return { ok: false, reason: "stale_facts: no inventory rows found for SKU" };
  }

  // Find the most recent observation across all locations.
  let latestObservedMs = 0;
  for (const row of rows) {
    const t = row.observed_at ? new Date(row.observed_at).getTime() : 0;
    if (t > latestObservedMs) latestObservedMs = t;
  }

  // Staleness check: the most recent observation must be within 60 min.
  if (nowMs - latestObservedMs > STOCK_FRESH_MS) {
    const ageMin = Math.round((nowMs - latestObservedMs) / 60000);
    return { ok: false, reason: `stale_facts: latest stock observation ${ageMin}min ago (> 60min threshold)` };
  }

  // All current (latest per location) rows must show available=0.
  // "Latest per location" = take the row with max(observed_at) per location_id.
  const latestByLocation = new Map<string, { available: number; observed_at: string }>();
  for (const row of rows) {
    const prev = latestByLocation.get(row.location_id);
    if (!prev || row.observed_at > prev.observed_at) {
      latestByLocation.set(row.location_id, { available: row.available, observed_at: row.observed_at });
    }
  }

  for (const [locId, { available }] of latestByLocation) {
    if (available > 0) {
      return {
        ok: false,
        reason: `variant_in_stock: location ${locId} shows available=${available}`,
      };
    }
  }

  return { ok: true };
}
