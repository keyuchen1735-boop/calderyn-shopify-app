// Maps connected shop_integrations rows to the ship-cost adapter that should run
// for them. One place that knows the full adapter set; the cron stays provider-blind.
// Mirrors ads/registry.server.ts — but with the CORRECTED status filter (see below).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShipCostAdapter } from "./adapter";
import { easyPostAdapter } from "./easypost.server";
import { shipBobAdapter } from "./shipbob.server";
import { shipHeroAdapter } from "./shiphero.server";

// Phase 1: easyPostAdapter. Phase 2 appends shippoAdapter. Phase 3 (Part B) appends the two
// 3PL houses below — both are pure drop-ins (contract C1): shipAdaptersForShops picks them
// up via their kinds with NO code change to the generic selection logic.
export const SHIP_ADAPTERS: ShipCostAdapter[] = [easyPostAdapter, shipBobAdapter, shipHeroAdapter];

export const BY_KIND = new Map<string, ShipCostAdapter>(
  SHIP_ADAPTERS.map((a) => [a.integrationKind, a]),
);

export interface ShipWorkItem {
  shopId: string;
  status: string; // 'ready' | 'pending' | 'live'
  adapter: ShipCostAdapter;
}

export async function shipAdaptersForShops(sb: SupabaseClient): Promise<ShipWorkItem[]> {
  const { data, error } = await sb
    .from("shop_integrations")
    .select("shop_id, kind, sync_status")
    .in("kind", [...BY_KIND.keys()])
    // Status filter (contract §8.1, trap confirmed LIVE): the API-key connect flow
    // writes sync_status='ready' (auth.quickbooks.$.tsx:96 precedent), so the ad
    // code's IN ('pending','live') would NEVER pick up a freshly-connected shop.
    // 'ready' is mandatory; 'live' re-pulls on later ticks; 'pending' is forward-compat.
    // 'error' is intentionally excluded — a broken credential waits for re-connect.
    .in("sync_status", ["ready", "pending", "live"]);
  if (error) throw error;

  const work: ShipWorkItem[] = [];
  for (const row of data ?? []) {
    const adapter = BY_KIND.get(String(row.kind));
    if (!adapter) continue; // unknown kind (e.g. an ads kind) → skip
    work.push({
      shopId: String(row.shop_id),
      status: String(row.sync_status),
      adapter,
    });
  }
  return work;
}
