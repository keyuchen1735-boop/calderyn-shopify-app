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
  status: string; // 'pending' | 'live' (an 'error' row is surfaced as 'pending')
  adapter: AdPlatformAdapter;
}

export async function adaptersForShops(sb: SupabaseClient): Promise<AdWorkItem[]> {
  // 'error' rows are included so a previously-failed sync can recover — both the
  // hourly cron AND the manual "Sync now" button drain this list, so excluding
  // 'error' would strand a failed integration forever (nothing else flips it
  // back). An errored row is surfaced as 'pending' so the runner does a full
  // backfill (idempotent upsert), guaranteeing it reaches a correct state
  // whether it never synced or had drifted while broken.
  const { data, error } = await sb
    .from("shop_integrations")
    .select("shop_id, kind, sync_status")
    .in("kind", ["meta_ads", "google_ads", "tiktok_ads"])
    .in("sync_status", ["pending", "live", "error"]);
  if (error) throw error;
  const work: AdWorkItem[] = [];
  for (const row of data ?? []) {
    const adapter = BY_KIND.get(String(row.kind));
    if (!adapter) continue;
    const raw = String(row.sync_status);
    const status = raw === "error" ? "pending" : raw;
    work.push({ shopId: String(row.shop_id), status, adapter });
  }
  return work;
}
