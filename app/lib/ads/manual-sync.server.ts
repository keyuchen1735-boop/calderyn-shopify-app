// Manual "Sync now" — the on-demand counterpart to cron.ingest-ads. A merchant
// can refresh their ad data without waiting for the hourly cron, but the button
// is rate-limited per shop so it can't be spammed into an API-quota problem.
//
// Two pure-ish pieces, both unit-tested:
//   - manualSyncCooldown(): decides whether a shop may sync right now.
//   - syncShopAds(): runs each connected adapter for ONE shop (backfill if the
//     integration is still pending, otherwise poll), isolating per-platform
//     failures so one bad provider can't block the others. Collaborators are
//     injected so the orchestration is testable without network or db.

import type { SupabaseClient } from "@supabase/supabase-js";
import { adaptersForShops, type AdWorkItem } from "./registry.server";
import { backfillAds, pollAdsDaily } from "./ingest.server";

/** Minimum gap between manual syncs for a single shop. */
export const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;

export interface CooldownVerdict {
  allowed: boolean;
  /** Seconds until the shop may sync again (0 when allowed). */
  retryAfterSec: number;
}

/**
 * Decide whether a shop whose last manual sync was `lastSyncIso` may sync at
 * `nowMs`. Fails OPEN on a missing/unparseable timestamp — a bad stored value
 * should never permanently lock a merchant out of refreshing.
 */
export function manualSyncCooldown(
  lastSyncIso: string | null | undefined,
  nowMs: number,
): CooldownVerdict {
  if (!lastSyncIso) return { allowed: true, retryAfterSec: 0 };
  const last = Date.parse(lastSyncIso);
  if (Number.isNaN(last)) return { allowed: true, retryAfterSec: 0 };
  const elapsed = nowMs - last;
  if (elapsed >= MANUAL_SYNC_COOLDOWN_MS) return { allowed: true, retryAfterSec: 0 };
  return {
    allowed: false,
    retryAfterSec: Math.ceil((MANUAL_SYNC_COOLDOWN_MS - elapsed) / 1000),
  };
}

export interface SyncResult {
  /** Platforms refreshed successfully (e.g. "meta", "tiktok"). */
  synced: string[];
  /** Platforms skipped because the adapter had no usable credentials. */
  skipped: string[];
  /** Per-platform error strings; one failure does not abort the rest. */
  errors: string[];
}

export interface SyncDeps {
  adaptersForShop: (sb: SupabaseClient, shopId: string) => Promise<AdWorkItem[]>;
  backfill: typeof backfillAds;
  poll: typeof pollAdsDaily;
}

const PLATFORM_LABEL: Record<string, string> = {
  meta: "Meta",
  google: "Google",
  tiktok: "TikTok",
};

function label(platform: string): string {
  return PLATFORM_LABEL[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

/** "a" | "a and b" | "a, b and c" */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface SyncToast {
  message: string;
  isError: boolean;
}

/** Turn a SyncResult into the one-line toast the merchant sees. */
export function formatSyncToast(result: SyncResult): SyncToast {
  const synced = joinNames(result.synced.map(label));
  const failed = joinNames(
    result.errors.map((e) => label(e.split(":")[0].trim())),
  );

  if (result.synced.length && result.errors.length) {
    return { message: `Synced ${synced}. Couldn't sync ${failed}.`, isError: true };
  }
  if (result.synced.length) {
    return { message: `Synced ${synced}.`, isError: false };
  }
  if (result.errors.length) {
    return { message: `Couldn't sync ${failed}.`, isError: true };
  }
  return { message: "No ad accounts connected to sync.", isError: false };
}

async function setSync(
  sb: SupabaseClient,
  shopId: string,
  kind: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await sb
    .from("shop_integrations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("kind", kind);
  if (error) throw error;
}

/** Default: derive this shop's ad work items from the shared registry. */
async function defaultAdaptersForShop(
  sb: SupabaseClient,
  shopId: string,
): Promise<AdWorkItem[]> {
  const all = await adaptersForShops(sb);
  return all.filter((w) => w.shopId === shopId);
}

const DEFAULT_DEPS: SyncDeps = {
  adaptersForShop: defaultAdaptersForShop,
  backfill: backfillAds,
  poll: pollAdsDaily,
};

/**
 * Refresh every connected ad integration for one shop, on demand. Pending
 * integrations get a full backfill (and flip to `live`); live ones get a daily
 * poll. Per-platform failures are recorded and the integration is marked
 * `error`, but the sweep continues to the next platform.
 */
export async function syncShopAds(
  sb: SupabaseClient,
  shopId: string,
  deps: SyncDeps = DEFAULT_DEPS,
): Promise<SyncResult> {
  const result: SyncResult = { synced: [], skipped: [], errors: [] };
  const work = await deps.adaptersForShop(sb, shopId);

  for (const { status, adapter } of work) {
    const source = await adapter.connect(shopId);
    if (!source) {
      result.skipped.push(adapter.platform);
      continue;
    }
    const now = new Date().toISOString();
    try {
      if (status === "pending") {
        await deps.backfill(source, adapter.platform, shopId, sb);
        await setSync(sb, shopId, adapter.integrationKind, {
          sync_status: "live",
          sync_error: null,
          last_sync_at: now,
        });
      } else {
        await deps.poll(source, adapter.platform, shopId, sb);
        // A successful poll must reset sync_status to "live", not just clear
        // the error message. Otherwise a row that previously hit sync_status:
        // "error" stays in error state forever even after subsequent polls
        // succeed, because no path here flips it back.
        await setSync(sb, shopId, adapter.integrationKind, {
          sync_status: "live",
          sync_error: null,
          last_sync_at: now,
        });
      }
      result.synced.push(adapter.platform);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setSync(sb, shopId, adapter.integrationKind, {
        sync_status: "error",
        sync_error: message.slice(0, 500),
      });
      result.errors.push(`${adapter.platform}: ${message}`);
    }
  }

  return result;
}
