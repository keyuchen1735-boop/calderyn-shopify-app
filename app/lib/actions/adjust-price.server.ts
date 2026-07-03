// app/lib/actions/adjust-price.server.ts
// Execute the adjust_price action against a shop-scoped alert: raise a SKU's
// selling price to restore its pre-erosion margin (margin_erosion / cogs_drift).
// Same trust contract as the other alert-action executors — the SKU comes from
// the alert record, the current price + COGS from authoritative sources, never
// the request body. The merchant MAY override the suggested price, but only
// within the guardrail cap. Confirm-only (never autopilot). Reversible via the
// adjust_price branch in undo.server.ts (restores params.prior_price_cents).

import type { SupabaseClient } from "@supabase/supabase-js";
import { CalderynError } from "../calderyn.server";
import { DETECTOR_TO_ACTIONS } from "../labels";
import { toNumericEvidence } from "../remediation/rank";
import { suggestAdjustPrice } from "../remediation/price";
import { fmtMoney } from "../format";
import { acknowledgeAlert } from "../alerts.server";
import { readVariantPrice, setVariantPrice } from "../shopify/price.server";
import type { AdminGraphqlClient } from "../shopify/inventory.server";
import { getCurrentUnitCostCents } from "../po/draft.server";
import type { AlertActionClient } from "./alert-action.server";
import { getOrgMode, writesToOwned, dualWrites } from "../cutover/org-mode.server";
import { getOwnedVariantPricing, setOwnedVariantPrice } from "./owned-writes.server";

export interface ResolvedSkuVariant {
  skuId: string;
  /** Shopify ProductVariant GID (sku_dim.external_id). */
  variantGid: string;
}

/** Resolve a SKU code to its internal id + Shopify variant GID, shop-scoped
 *  (the ownership guard). Returns null when the code isn't owned or has no
 *  variant id — the gateway surfaces that rather than offering a dead button. */
export async function resolveSkuVariant(
  sb: SupabaseClient,
  shopId: string,
  skuCode: string,
): Promise<ResolvedSkuVariant | null> {
  const { data, error } = await sb
    .from("sku_dim")
    .select("id, external_id")
    .eq("shop_id", shopId)
    .eq("sku", skuCode)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id || !data?.external_id) return null;
  return { skuId: String(data.id), variantGid: String(data.external_id) };
}

export async function executeAdjustPriceAlertAction(opts: {
  client: AlertActionClient;
  admin: AdminGraphqlClient;
  sb: SupabaseClient;
  shopId: string;
  alertId: string;
  kind: "adjust_price";
  idempotencyKey: string;
  /** Merchant-confirmed price (cents). Omit to apply the engine suggestion. */
  newPriceCents?: number;
  actor?: string;
  triggerReason?: string | null;
  signal?: AbortSignal;
}): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const { client, admin, sb, shopId, alertId, kind, idempotencyKey, newPriceCents, actor, triggerReason, signal } =
    opts;

  const alert = await client.alerts.get(alertId, signal);

  if (alert.status !== "open") {
    throw new CalderynError({
      code: "alert_not_open",
      status: 409,
      message: `This alert is ${alert.status}; actions only apply to open alerts.`,
    });
  }

  const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"];
  if (!allowed.includes(kind)) {
    throw new CalderynError({
      code: "action_not_allowed",
      status: 403,
      message: `"${kind}" is not a permitted action for this alert.`,
    });
  }

  const guardrails = await client.guardrails.get(signal);
  if (alert.dollar_impact > guardrails.dollar_cap_cents) {
    throw new CalderynError({
      code: "guardrail_dollar_cap",
      status: 403,
      message: `This action's impact (${fmtMoney(alert.dollar_impact)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
    });
  }

  if (!alert.sku) {
    throw new CalderynError({
      code: "adjust_price_no_sku",
      status: 422,
      message: "This alert has no SKU to reprice.",
    });
  }

  // Route the price write by the shop's cutover mode: at `live` the target price lives in
  // the owned catalog (no Shopify variant needed); every other mode reads + writes Shopify
  // exactly as before, and `dual_run` ALSO mirrors the applied price into the owned catalog
  // best-effort. The guardrail cap is anchored on whichever current price we read, so the
  // safety envelope is identical on both branches — only the WRITE target changes.
  const orgMode = await getOrgMode(shopId);
  const owned = writesToOwned(orgMode);
  const dual = dualWrites(orgMode);

  // `current.priceCents` anchors the suggestion + cap; `ownedVariantId` / `shopifyTarget`
  // carry the write handle for the branch we're on.
  let current: { priceCents: number };
  let ownedVariantId: string | null = null;
  let shopifyTarget: { variantGid: string; productGid: string; skuId: string } | null = null;

  if (owned) {
    const priced = await getOwnedVariantPricing(shopId, alert.sku);
    if (!priced) {
      throw new CalderynError({
        code: "sku_not_found",
        status: 422,
        message: "This SKU has no owned price to change.",
      });
    }
    ownedVariantId = priced.variantId;
    current = { priceCents: priced.currentPriceCents };
  } else {
    const target = await resolveSkuVariant(sb, shopId, alert.sku);
    if (!target) {
      throw new CalderynError({
        code: "sku_not_found",
        status: 422,
        message: "This SKU has no linked Shopify variant, so its price can't be changed here.",
      });
    }
    // Read the live current price (anchors both the suggestion and the cap). A read
    // failure must not proceed blind.
    let live: { priceCents: number; productGid: string };
    try {
      live = await readVariantPrice(admin, target.variantGid);
    } catch (err) {
      throw new CalderynError({
        code: "action_failed",
        status: 502,
        message: err instanceof Error ? err.message : "Couldn't read the current Shopify price.",
      });
    }
    current = { priceCents: live.priceCents };
    shopifyTarget = { variantGid: target.variantGid, productGid: live.productGid, skuId: target.skuId };
  }

  const capPct = guardrails.max_price_change_pct;
  // Current COGS anchors the suggestion AND the below-cost floor on an override.
  const currentCogsCents = await getCurrentUnitCostCents(sb, shopId, alert.sku);
  let finalPriceCents: number;
  let capped = false;

  if (newPriceCents != null) {
    // Merchant override — bound it to ±capPct of the current price (a magnitude
    // guard against fat-fingers in either direction; rule 12: reject visibly).
    if (!Number.isInteger(newPriceCents) || newPriceCents <= 0) {
      throw new CalderynError({
        code: "invalid_price",
        status: 422,
        message: "Price must be a positive whole number of cents.",
      });
    }
    const maxCents = Math.round(current.priceCents * (1 + capPct / 100));
    const minCents = Math.round(current.priceCents * (1 - capPct / 100));
    if (newPriceCents > maxCents || newPriceCents < minCents) {
      throw new CalderynError({
        code: "guardrail_price_cap",
        status: 422,
        message: `That price is more than ${capPct}% from the current ${fmtMoney(current.priceCents)}. Adjust it within ±${capPct}% or raise the cap in Settings.`,
      });
    }
    if (newPriceCents === current.priceCents) {
      throw new CalderynError({
        code: "price_unchanged",
        status: 422,
        message: "That's the current price — nothing to change.",
      });
    }
    // This action exists to RESTORE margin — never let an override price the SKU
    // below its own cost (a guaranteed per-unit loss). Only enforced when COGS is
    // known; an unknown cost can't prove a loss.
    if (currentCogsCents != null && newPriceCents <= currentCogsCents) {
      throw new CalderynError({
        code: "price_below_cost",
        status: 422,
        message: `That price is at or below this product's unit cost (${fmtMoney(currentCogsCents)}) — it would sell at a loss.`,
      });
    }
    finalPriceCents = newPriceCents;
  } else {
    // Engine suggestion: restore the SKU's pre-erosion margin, clamped to capPct.
    // ponytail: the cogs_drift suggestion is target = live_price + cost_delta, so
    // it is NOT idempotent — a re-run after the price already moved would compound.
    // The status!=="open" guard above closes the realistic single-actor cases
    // (double-click is also blocked by the UI busy flag; a client retry sees the
    // now-acknowledged alert and 409s). A truly simultaneous two-request race
    // remains theoretically possible — the same read-then-act ceiling the codebase
    // accepts for undo (undo.server.ts). Airtight fix if it ever bites: an atomic
    // open→acknowledged claim before the write, rolled back on failure.
    const suggestion = suggestAdjustPrice({
      detectorId: alert.detector_id,
      evidence: toNumericEvidence(alert.evidence ?? {}),
      currentPriceCents: current.priceCents,
      currentCogsCents,
      capPct,
    });
    if (!suggestion) {
      throw new CalderynError({
        code: "no_price_suggestion",
        status: 422,
        message:
          "Can't compute a price that restores this SKU's margin — set a price manually or review the alert.",
      });
    }
    finalPriceCents = suggestion.newPriceCents;
    capped = suggestion.capped;
  }

  // Apply the price on the routed target. A failure throws — the audit row below is only
  // written on success (rule 12: no "succeeded" row for an unchanged price).
  let appliedPriceCents: number;
  const params: Record<string, unknown> = {
    target: alert.sku,
    sku: alert.sku,
    prior_price_cents: current.priceCents,
    capped,
    estimate_cents: alert.dollar_impact,
  };

  if (owned && ownedVariantId) {
    try {
      await setOwnedVariantPrice(shopId, ownedVariantId, finalPriceCents);
    } catch (err) {
      throw new CalderynError({
        code: "action_failed",
        status: 502,
        message: err instanceof Error ? err.message : "Owned price update failed.",
      });
    }
    appliedPriceCents = finalPriceCents;
    // `owned: true` routes undo to the owned catalog (undo.server.ts adjust_price branch).
    params.owned = true;
    params.sku_id = ownedVariantId;
    params.variant_id = ownedVariantId;
    params.new_price_cents = appliedPriceCents;
  } else if (shopifyTarget) {
    let applied: { priceCents: number };
    try {
      applied = await setVariantPrice(admin, {
        productGid: shopifyTarget.productGid,
        variantId: shopifyTarget.variantGid,
        newPriceCents: finalPriceCents,
      });
    } catch (err) {
      throw new CalderynError({
        code: "action_failed",
        status: 502,
        message: err instanceof Error ? err.message : "Shopify price update failed.",
      });
    }
    appliedPriceCents = applied.priceCents;
    params.sku_id = shopifyTarget.skuId;
    params.variant_id = shopifyTarget.variantGid;
    params.product_id = shopifyTarget.productGid;
    params.new_price_cents = appliedPriceCents;

    // dual_run: mirror the applied price into the owned catalog so it tracks reality
    // during the side-by-side run. Shopify (above) stays authoritative — a mirror
    // failure never fails the action; it is recorded on the audit row and the go-live
    // parity gate will hold the divergence visible until reconciled (rule 12).
    if (dual) {
      try {
        const mirror = await getOwnedVariantPricing(shopId, alert.sku);
        if (!mirror) {
          params.dual_write = "skipped_no_owned_price";
        } else {
          await setOwnedVariantPrice(shopId, mirror.variantId, appliedPriceCents);
          params.dual_write = "ok";
          params.owned_variant_id = mirror.variantId;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        params.dual_write = `failed: ${msg}`;
        console.error("[adjust-price] dual_run owned mirror write failed", err);
      }
    }
  } else {
    // Unreachable: exactly one of the two branches resolves a write handle above.
    throw new CalderynError({ code: "action_failed", status: 500, message: "No price write target resolved." });
  }
  // Record which system the price write landed in (extend:write-back): the owned
  // catalog at `live`, the Shopify Admin API on every other mode (dual_run's owned
  // mirror is best-effort, so Shopify stays the authoritative target).
  const audit = await client.actions.execute({
    alertId,
    kind,
    params,
    idempotencyKey,
    actor,
    triggerReason,
    writeTarget: owned ? "owned_sot" : "shopify_admin",
  });

  const acknowledged = await acknowledgeAlert(sb, shopId, alertId);
  return { auditId: audit.id, outcome: audit.outcome ?? "succeeded", acknowledged };
}
