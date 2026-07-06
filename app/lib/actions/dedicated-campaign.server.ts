// Trusted SKU → campaign resolution for autopilot candidates that carry no
// campaign reference (SKU-scoped alerts such as a stockout the engine could
// not key to a campaign). There is no structured SKU→campaign key in the
// schema; dedication is INFERRED by v_sku_remediation_inputs — a campaign
// qualifies only when this SKU is >= 70% of its attributed revenue AND the
// campaign is active with a non-null daily budget. The same view feeds the
// merchant-facing remediation panel, so autopilot and the UI can never
// disagree about which campaign a SKU "owns".
//
// Fail-closed: any read error, missing row, or missing dedication resolves to
// null and the caller must NOT act (the candidate stays queued for the
// merchant). Ownership is additionally re-verified downstream — executeAction
// refuses a campaign that does not belong to the shop.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolvedDedicatedCampaign {
  campaignId: string;
  platform: string | null;
  /** Current daily budget (cents) from the view; null when unbudgeted. */
  dailyBudgetCents: number | null;
  /** Trailing-7-day spend (cents) — feeds the min-spend guardrail exactly like
   *  v_autopilot_candidates.campaign_spend_cents does for keyed candidates. */
  spendCents: number;
}

/** Sum a campaign's trailing-7-day spend, mirroring the
 *  v_autopilot_candidates window (`day >= CURRENT_DATE - 7`). The shop_id
 *  filter is defense-in-depth: campaign_id is globally unique today
 *  (ingest upserts on (campaign_id, day)), but a tenant filter keeps this
 *  read safe even if that ever changes.
 *  Returns null on any read error (caller treats as "cannot verify" → skip). */
export async function campaignSpend7dCents(
  sb: SupabaseClient,
  shopId: string,
  campaignId: string,
): Promise<number | null> {
  try {
    const sinceDay = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const { data, error } = await sb
      .from("ad_spend_fact")
      .select("spend_cents")
      .eq("shop_id", shopId)
      .eq("campaign_id", campaignId)
      .gte("day", sinceDay);
    if (error) throw new Error(error.message);
    // Fail closed on an absent/empty read (contract above): an active, budgeted
    // dedicated campaign with zero ad_spend_fact rows in the window is far more
    // likely a sync gap than a verified $0 — returning 0 here would let the
    // caller act on spend that was never actually confirmed. Treat "no rows" as
    // "cannot verify" so the alert stays queued for the merchant instead.
    if (data == null || data.length === 0) {
      console.warn(
        `[dedicated-campaign] no spend rows for ${campaignId} in the window — treating as unverifiable (fail closed)`,
      );
      return null;
    }
    // PostgREST clamps responses at ~1000 rows. Today the fact grain is one
    // row per (campaign, day) — max 7 rows here — but if the grain ever gets
    // finer, a clamped page would silently under-count. Fail closed instead.
    if (data.length >= 1000) {
      console.error(
        `[dedicated-campaign] spend read for ${campaignId} hit the row clamp — refusing a partial sum`,
      );
      return null;
    }
    let total = 0;
    for (const r of data ?? []) {
      const n = Number((r as { spend_cents?: unknown }).spend_cents);
      if (Number.isFinite(n)) total += n;
    }
    return total;
  } catch (err) {
    console.error(
      `[dedicated-campaign] spend read failed for ${campaignId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Resolve the dedicated mutable campaign for a SKU, or null when none exists
 * (shared/catalog campaigns stay manual — rule 12 keeps the alert queued with
 * its honest reason instead of guessing).
 */
export async function resolveDedicatedCampaign(
  sb: SupabaseClient,
  shopId: string,
  ref: { skuId?: string | null; sku?: string | null },
): Promise<ResolvedDedicatedCampaign | null> {
  try {
    const skuId = typeof ref.skuId === "string" && ref.skuId ? ref.skuId : null;
    const sku = typeof ref.sku === "string" && ref.sku ? ref.sku : null;
    if (!skuId && !sku) return null;

    const sel = sb
      .from("v_sku_remediation_inputs")
      .select("dedicated_campaign_id, dedicated_campaign_platform, dedicated_campaign_budget_cents")
      .eq("shop_id", shopId);
    const { data, error } = await (skuId ? sel.eq("sku_id", skuId) : sel.eq("sku", sku!)).maybeSingle();
    if (error) throw new Error(error.message);

    const row = data as {
      dedicated_campaign_id: string | null;
      dedicated_campaign_platform: string | null;
      dedicated_campaign_budget_cents: number | null;
    } | null;
    if (!row?.dedicated_campaign_id) return null;

    const spendCents = await campaignSpend7dCents(sb, shopId, row.dedicated_campaign_id);
    if (spendCents == null) return null; // cannot verify spend → do not act

    return {
      campaignId: row.dedicated_campaign_id,
      platform: row.dedicated_campaign_platform ?? null,
      dailyBudgetCents:
        row.dedicated_campaign_budget_cents == null ? null : Number(row.dedicated_campaign_budget_cents),
      spendCents,
    };
  } catch (err) {
    console.error(
      `[dedicated-campaign] resolve failed for shop ${shopId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
