// Freshness + live precondition re-check (I4) and the stockout pause allowlist (I10).
//
// MONEY-PATH INVARIANTS (never relax):
//   - Every function is fail-safe: a thrown DB read or a missing datum returns
//     ok:false. An ok:false means the action is SKIPPED (queued), NEVER executed.
//   - Never default to allowing an action when a required datum is unavailable.
//   - Called after graduation + guardrails pass and BEFORE executeAction.
//
// Shopify inventory policy + tracking state are synced onto sku_dim by both the
// initial GraphQL backfill and products/update webhooks. Missing/null values
// remain fail-safe and block autonomous stockout pauses.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";
import type { Candidate } from "../actions/autopilot-targeting.server";

/** Staleness thresholds */
const STOCK_FRESH_MS = 60 * 60 * 1000; // 60 minutes
const SPEND_FRESH_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Campaign statuses that mean "actively running and spending". Exported so
 * the organic-signal sweep classifies platform state identically. */
export const ACTIVE_CAMPAIGN_STATUSES = new Set([
  "active",
  "ACTIVE",
  "enabled",
  "ENABLED",
]);

/** Campaign statuses that mean "paused or ended — precondition already gone".
 * Exported so the organic-signal sweep classifies platform state identically. */
export const INACTIVE_CAMPAIGN_STATUSES = new Set([
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
  campaignId?: string;
  nowMs?: number;
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

    if (kind === "resume_campaign") {
      // The inverse of pause: resume restarts spend, so the campaign must still
      // be PAUSED (not already running). If it is active again — a merchant or
      // another path resumed it — there is nothing to resume; abort.
      const isActive = ACTIVE_CAMPAIGN_STATUSES.has(campaign.status);
      const isInactive = INACTIVE_CAMPAIGN_STATUSES.has(campaign.status);
      if (isActive || !isInactive) {
        return {
          ok: false,
          reason: `precondition_stale: not paused (status=${campaign.status})`,
        };
      }
      return { ok: true };
    }

    if (kind === "reduce_campaign_budget") {
      // The precondition: live daily_budget_cents must still MATCH the snapshot
      // the cut was computed from. The target budget is an ABSOLUTE value
      // derived from the snapshot, so any drift makes it wrong in one of two
      // dangerous ways: live < snapshot means someone already cut it (a second
      // cut double-punishes); live > snapshot means the merchant RAISED it, and
      // applying the stale absolute target would be a far deeper cut than the
      // cap the guardrails approved (e.g. snapshot $100 → target $80, merchant
      // raised to $500 → an 84% cut). Either way: abort, let it re-queue.
      // If candidate.daily_budget_cents is null, we have no baseline → fail-safe.
      if (candidate.daily_budget_cents == null) {
        return { ok: false, reason: "precondition_stale: budget already at/below target (no snapshot)" };
      }

      const liveBudget = campaign.daily_budget_cents ?? 0;
      const snapshotBudget = candidate.daily_budget_cents;

      if (liveBudget !== snapshotBudget) {
        return {
          ok: false,
          reason:
            liveBudget < snapshotBudget
              ? `precondition_stale: budget already at/below target (live=${liveBudget}c < snapshot=${snapshotBudget}c)`
              : `precondition_stale: budget raised since alert (live=${liveBudget}c > snapshot=${snapshotBudget}c)`,
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
 *   2. inventory_policy = 'deny' (NOT 'continue') for every product variant.
 *   3. Inventory tracking is ON for every product variant.
 *   4. ALL variants show available = 0 at every observed location.
 *   5. The latest stock observation is fresh (<= 60 min old).
 *   6. The campaign is still actively spending (status = ACTIVE/ENABLED).
 *
 * When any condition cannot be verified (data missing from schema), returns ok:false.
 * This is the intentional safe default: "when unsure, queue for human review."
 *
 */
export async function stockoutPauseAllowed(input: StockoutAllowedInput): Promise<PreconditionResult> {
  try {
    // Gate 1: sku_id must be in entity_ref.
    const entityRef = input.alert.entity_ref ?? {};
    const skuId = typeof entityRef.sku_id === "string" ? entityRef.sku_id : null;
    if (!skuId) {
      return { ok: false, reason: "sku_id_missing: entity_ref has no sku_id" };
    }
    if (!input.campaignId) {
      return { ok: false, reason: "campaign_id_missing: cannot verify active spend" };
    }

    const { data: target, error: targetErr } = await input.sb
      .from("sku_dim")
      .select("id, product_id, inventory_policy, inventory_tracked")
      .eq("shop_id", input.shopId)
      .eq("id", skuId)
      .maybeSingle();
    if (targetErr) return { ok: false, reason: `db_error reading sku: ${targetErr.message}` };
    if (!target?.product_id) return { ok: false, reason: "sku_not_found" };

    const { data: variants, error: variantsErr } = await input.sb
      .from("sku_dim")
      .select("id, product_id, inventory_policy, inventory_tracked")
      .eq("shop_id", input.shopId)
      .eq("product_id", target.product_id);
    if (variantsErr) return { ok: false, reason: `db_error reading variants: ${variantsErr.message}` };
    if (!variants?.length) return { ok: false, reason: "variants_not_found" };
    if (variants.some((v) => v.inventory_policy !== "deny")) {
      return { ok: false, reason: "inventory_policy_not_deny" };
    }
    if (variants.some((v) => v.inventory_tracked !== true)) {
      return { ok: false, reason: "inventory_tracking_off" };
    }

    const stockCheck = await checkVariantsFreshAndEmpty(
      input.shopId,
      variants.map((v) => String(v.id)),
      input.sb,
      input.nowMs ?? Date.now(),
    );
    if (!stockCheck.ok) return stockCheck;

    const { data: campaign, error: campaignErr } = await input.sb
      .from("ad_campaign_dim")
      .select("id, status, last_synced_at")
      .eq("shop_id", input.shopId)
      .eq("id", input.campaignId)
      .maybeSingle();
    if (campaignErr) return { ok: false, reason: `db_error reading campaign: ${campaignErr.message}` };
    if (!campaign) return { ok: false, reason: "campaign_not_found" };
    if (!ACTIVE_CAMPAIGN_STATUSES.has(String(campaign.status))) {
      return { ok: false, reason: `precondition_stale: campaign not active (${campaign.status})` };
    }
    const nowMs = input.nowMs ?? Date.now();
    const syncedAt = campaign.last_synced_at ? new Date(campaign.last_synced_at).getTime() : 0;
    if (nowMs - syncedAt > SPEND_FRESH_MS) {
      return { ok: false, reason: "stale_facts: campaign sync older than 24h" };
    }
    return { ok: true };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preconditions] stockoutPauseAllowed threw: ${msg}`);
    return { ok: false, reason: `threw: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// stockoutClearedResumeAllowed (Slice B: auto-resume on stockout-clear)
// ---------------------------------------------------------------------------

interface StockoutClearedResumeAllowedInput {
  shopId: string;
  /** The resume-candidate alert. entity_ref carries {campaign_id, sku_id, sku}. */
  alert: { id: string; detector_id: string; entity_ref: Record<string, unknown> };
  /** The restock buffer the alert cleared (alert evidence.buffer_units). */
  bufferUnits: number;
  sb: SupabaseClient;
  nowMs?: number;
}

/**
 * Live re-check before an autonomous resume_campaign — the resume analogue of
 * stockoutPauseAllowed (I10). Resuming restarts spend, so it returns ok:true
 * ONLY when ALL of the following hold, re-read live at execution time:
 *   1. entity_ref carries both campaign_id and sku_id.
 *   2. The campaign is STILL paused on the platform and freshly synced (<= 24h).
 *   3. fork #1: the LATEST action_audit row for the campaign is Calderyn's own
 *      autopilot pause_campaign — never override a merchant who took it over.
 *   4. fork #2: the SKU's latest per-location stock is fresh (<= 60 min) and the
 *      total is at or above the buffer the alert was raised against.
 *
 * Fail-safe: any missing datum, DB error, or thrown read returns ok:false
 * ("when unsure, leave it queued for the merchant"). Never throws.
 */
export async function stockoutClearedResumeAllowed(
  input: StockoutClearedResumeAllowedInput,
): Promise<PreconditionResult> {
  try {
    const nowMs = input.nowMs ?? Date.now();
    const entityRef = input.alert.entity_ref ?? {};
    const skuId = typeof entityRef.sku_id === "string" ? entityRef.sku_id : null;
    const campaignId = typeof entityRef.campaign_id === "string" ? entityRef.campaign_id : null;
    if (!skuId) return { ok: false, reason: "sku_id_missing: entity_ref has no sku_id" };
    if (!campaignId) return { ok: false, reason: "campaign_id_missing: entity_ref has no campaign_id" };
    // Fail-safe (MONEY-PATH INVARIANT): a missing/zero buffer is an unverifiable
    // anti-flip-flop threshold, not "no buffer required". The detector always
    // emits buffer_units >= MIN_RESTOCK_UNITS, so 0/NaN means malformed/legacy
    // evidence — skip rather than resume on an unbounded restock check.
    if (!Number.isFinite(input.bufferUnits) || input.bufferUnits <= 0) {
      return { ok: false, reason: "buffer_units_missing: cannot verify restock buffer" };
    }

    // 1. Campaign must still be PAUSED on the platform + freshly synced.
    const { data: campaign, error: campErr } = await input.sb
      .from("ad_campaign_dim")
      .select("id, status, last_synced_at")
      .eq("shop_id", input.shopId)
      .eq("id", campaignId)
      .maybeSingle();
    if (campErr) return { ok: false, reason: `db_error reading campaign: ${campErr.message}` };
    if (!campaign) return { ok: false, reason: "campaign_not_found" };
    const status = String(campaign.status);
    if (ACTIVE_CAMPAIGN_STATUSES.has(status) || !INACTIVE_CAMPAIGN_STATUSES.has(status)) {
      return { ok: false, reason: `precondition_stale: campaign not paused (${status})` };
    }
    const syncedAt = campaign.last_synced_at ? new Date(campaign.last_synced_at).getTime() : 0;
    if (nowMs - syncedAt > SPEND_FRESH_MS) {
      return { ok: false, reason: "stale_facts: campaign sync older than 24h" };
    }

    // 2. fork #1: the latest action on this campaign must be Calderyn's pause.
    const { data: latest, error: actErr } = await input.sb
      .from("action_audit")
      .select("action_kind, actor_user_id, created_at")
      .eq("shop_id", input.shopId)
      .filter("params->>campaign_id", "eq", campaignId)
      .order("created_at", { ascending: false })
      // Deterministic tie-break so two same-timestamp rows can't flip which
      // "latest action" we read (and thus the merchant-takeover guard).
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (actErr) return { ok: false, reason: `db_error reading action_audit: ${actErr.message}` };
    if (!latest) return { ok: false, reason: "no_calderyn_pause: campaign has no recorded action" };
    if (latest.action_kind !== "pause_campaign" || latest.actor_user_id !== "autopilot") {
      return {
        ok: false,
        reason: `precondition_stale: latest action is ${latest.actor_user_id}/${latest.action_kind}, not Calderyn's pause`,
      };
    }

    // 3. fork #2: SKU restocked above buffer with a fresh observation per location.
    const stockCheck = await sumLatestStockFresh(input.shopId, skuId, input.sb, nowMs);
    if (!stockCheck.ok) return stockCheck;
    if ((stockCheck.units ?? 0) < input.bufferUnits) {
      return {
        ok: false,
        reason: `restock_below_buffer: ${stockCheck.units} < ${input.bufferUnits} units`,
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[preconditions] stockoutClearedResumeAllowed threw: ${msg}`);
    return { ok: false, reason: `threw: ${msg}` };
  }
}

/** Sum the latest-per-location available stock for a SKU, requiring every
 *  location's latest observation to be fresh (<= 60 min). Fail-safe on any DB
 *  error / missing rows / stale observation. */
async function sumLatestStockFresh(
  shopId: string,
  skuId: string,
  sb: SupabaseClient,
  nowMs: number,
): Promise<PreconditionResult & { units?: number }> {
  const { data: rows, error } = await sb
    .from("inventory_level_fact")
    .select("sku_id, location_id, available, observed_at")
    .eq("shop_id", shopId)
    .eq("sku_id", skuId);
  if (error) return { ok: false, reason: `db_error reading inventory: ${error.message}` };
  if (!rows?.length) return { ok: false, reason: "stale_facts: no inventory rows found" };

  const latest = new Map<string, { available: number; observedAt: string }>();
  for (const row of rows) {
    const key = String(row.location_id);
    const prev = latest.get(key);
    if (!prev || String(row.observed_at) > prev.observedAt) {
      latest.set(key, {
        available: Number(row.available ?? 0),
        observedAt: String(row.observed_at ?? ""),
      });
    }
  }
  let total = 0;
  for (const { available, observedAt } of latest.values()) {
    const t = new Date(observedAt).getTime();
    if (!Number.isFinite(t) || nowMs - t > STOCK_FRESH_MS) {
      return { ok: false, reason: "stale_facts: stock observation older than 60min" };
    }
    total += available;
  }
  return { ok: true, units: total };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function checkVariantsFreshAndEmpty(
  shopId: string,
  skuIds: string[],
  sb: SupabaseClient,
  nowMs: number,
): Promise<PreconditionResult> {
  const { data: rows, error } = await sb
    .from("inventory_level_fact")
    .select("sku_id, location_id, available, observed_at")
    .eq("shop_id", shopId)
    .in("sku_id", skuIds);
  if (error) return { ok: false, reason: `db_error reading inventory: ${error.message}` };
  if (!rows?.length) return { ok: false, reason: "stale_facts: no inventory rows found" };

  const latest = new Map<string, { skuId: string; available: number; observedAt: string }>();
  for (const row of rows) {
    const key = `${row.sku_id}:${row.location_id}`;
    const prev = latest.get(key);
    if (!prev || String(row.observed_at) > prev.observedAt) {
      latest.set(key, {
        skuId: String(row.sku_id),
        available: Number(row.available ?? 0),
        observedAt: String(row.observed_at ?? ""),
      });
    }
  }
  for (const skuId of skuIds) {
    const skuRows = [...latest.values()].filter((row) => row.skuId === skuId);
    if (!skuRows.length) return { ok: false, reason: `stale_facts: no inventory rows for ${skuId}` };
    for (const row of skuRows) {
      const observedMs = new Date(row.observedAt).getTime();
      if (!Number.isFinite(observedMs) || nowMs - observedMs > STOCK_FRESH_MS) {
        return { ok: false, reason: "stale_facts: stock observation older than 60min" };
      }
      if (row.available > 0) return { ok: false, reason: "variant_in_stock" };
    }
  }
  return { ok: true };
}

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
