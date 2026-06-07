// Maps connected shop_integrations rows to the adapter that should run for them.
// One place that knows the full adapter set; the cron stays platform-blind.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdPlatformAdapter } from "./adapter";
import { metaAdapter } from "../meta/ingest.server";
import { googleAdapter } from "../google/ingest.server";
import { tiktokAdapter } from "../tiktok/ingest.server";

export const AD_ADAPTERS: AdPlatformAdapter[] = [metaAdapter, googleAdapter, tiktokAdapter];

const BY_KIND = new Map<string, AdPlatformAdapter>(AD_ADAPTERS.map((a) => [a.integrationKind, a]));

export interface AdWorkItem {
  shopId: string;
  status: string; // 'pending' | 'live'
  adapter: AdPlatformAdapter;
}

export async function adaptersForShops(sb: SupabaseClient): Promise<AdWorkItem[]> {
  const { data, error } = await sb
    .from("shop_integrations")
    .select("shop_id, kind, sync_status")
    .in("kind", ["meta_ads", "google_ads", "tiktok_ads"])
    .in("sync_status", ["pending", "live"]);
  if (error) throw error;
  const work: AdWorkItem[] = [];
  for (const row of data ?? []) {
    const adapter = BY_KIND.get(String(row.kind));
    if (!adapter) continue;
    work.push({ shopId: String(row.shop_id), status: String(row.sync_status), adapter });
  }
  return work;
}
