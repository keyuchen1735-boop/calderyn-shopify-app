// Per-shop "showcase mode".
//
// A demo/showcase store (shops.demo_mode = true) is seeded with synthetic
// campaigns and inventory that have NO live object on Meta/Google/TikTok or
// Shopify. When a merchant clicks Pause / Reduce budget / Reallocate during a
// live demo, the real platform call would 404 on those synthetic ids and surface
// an error. For a showcase shop we instead record the intended result WITHOUT
// the external call, so the walkthrough is clean.
//
// Scope is intentionally narrow: ONLY the external platform side effect is
// simulated. Ownership checks, audit writes, idempotency, guardrails, alert
// acknowledgement, the optimistic mirror update, and undo all run exactly as in
// production — so the audit log, Recovered total, campaign/inventory state, and
// undo stay truthful to what the merchant actually clicked.
//
// Real shops (demo_mode = false, the column default) are completely unaffected:
// isShowcaseShop returns false and every executor falls through to the live
// adapter / Shopify mutation as before.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase.server";
import type { Platform } from "../ads/adapter";
import type { ActionAdapter, CampaignActionState } from "../ads/actions";
import {
  inventoryAdjustQuantities,
  type AdminGraphqlClient,
  type InventoryAdjustInput,
  type InventoryAdjustResult,
} from "../shopify/inventory.server";

// Process-cached per shop: demo_mode rarely changes and every action path hits
// this check. A miss costs one indexed lookup; the value is then stable for the
// process lifetime (same stance as the shopId cache in supabase.server.ts). A
// cold start re-reads it, so toggling demo_mode in the DB takes effect on the
// next deploy/restart — acceptable for a flag flipped by hand, never per request.
const demoModeCache = new Map<string, boolean>();

/** True when this shop is a demo/showcase store whose action side effects are simulated. */
export async function isShowcaseShop(
  shopId: string,
  sb: SupabaseClient = getSupabase(),
): Promise<boolean> {
  const cached = demoModeCache.get(shopId);
  if (cached !== undefined) return cached;
  try {
    const { data, error } = await sb
      .from("shops")
      .select("demo_mode")
      .eq("id", shopId)
      .maybeSingle();
    if (error) {
      // Fail SAFE: treat as a real shop (no simulation) so a transient lookup
      // error can never silently turn a real merchant's action into a no-op.
      // Logged, not swallowed (rule 12). Not cached, so it re-checks next time.
      console.error(`[showcase] demo_mode lookup failed for shop ${shopId}`, error);
      return false;
    }
    const on = Boolean(data?.demo_mode);
    demoModeCache.set(shopId, on);
    return on;
  } catch (err) {
    // Same fail-safe stance for a thrown client error (e.g. an unconfigured
    // client). Real shops must never silently become no-ops.
    console.error(`[showcase] demo_mode lookup threw for shop ${shopId}`, err);
    return false;
  }
}

// A simulated platform operation id, clearly namespaced so anything inspecting
// an audit row's params/operation id can tell it was a showcase no-op rather
// than a real platform operation.
export const SHOWCASE_OPERATION_ID = "gid://calderyn/Showcase/simulated";

/**
 * An ActionAdapter that satisfies the contract by succeeding with no network
 * call. Returned by actionAdapterForShop for a demo shop so pause / resume /
 * budget changes (and their undos, and reallocate_budget) all succeed on seeded
 * campaigns that have no live platform object.
 */
export function showcaseActionAdapter(platform: Platform): ActionAdapter {
  return {
    platform,
    async pause() {},
    async resume() {},
    async setDailyBudget() {},
    async getState(): Promise<CampaignActionState> {
      return { status: "active", dailyBudgetCents: null };
    },
  };
}

/** The simulated result of a Shopify inventory transfer for a showcase shop. */
export function showcaseInventoryResult(): { operationId: string } {
  return { operationId: SHOWCASE_OPERATION_ID };
}

/**
 * Shop-aware wrapper used by every inventory-relocation executor (alert action,
 * inventory page, dashboard, undo). For a showcase/demo store the transfer is
 * simulated — the seeded inventory item has no live Shopify object, so a real
 * inventoryAdjustQuantities call would reject the synthetic gid and surface an
 * error mid-demo. Real shops fall through to the live Shopify mutation, so its
 * gid validation and userErrors handling still apply to them unchanged.
 *
 * Lives here (not in shopify/inventory.server) so the executors' unit tests,
 * which mock inventoryAdjustQuantities at the module boundary, still see that
 * mock through this wrapper's import.
 */
export async function inventoryAdjustQuantitiesForShop(
  shopId: string,
  admin: AdminGraphqlClient,
  input: InventoryAdjustInput,
  sb: SupabaseClient,
): Promise<InventoryAdjustResult> {
  if (await isShowcaseShop(shopId, sb)) return showcaseInventoryResult();
  return inventoryAdjustQuantities(admin, input);
}
