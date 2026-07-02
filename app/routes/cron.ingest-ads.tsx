import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { adaptersForShops, type AdWorkItem } from "~/lib/ads/registry.server";
import { backfillAds, pollAdsDaily } from "~/lib/ads/ingest.server";
import { mapWithConcurrency } from "~/lib/ads/concurrency";

const CONCURRENCY = 4; // bounded fan-out across shops × adapters

async function setSync(shopId: string, kind: string, patch: Record<string, unknown>): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();
  // supabase-js returns { error } without throwing; a silently-dropped status
  // write on the success path would report a sync that never persisted (stale
  // "pending" → endless re-backfill, or a missed last_sync_at). Throw so the
  // pool records it as a real failure instead of a false success.
  const { error } = await sb
    .from("shop_integrations")
    .update({ ...patch, updated_at: now })
    .eq("shop_id", shopId)
    .eq("kind", kind);
  if (error) throw error;
}

async function runOne(item: AdWorkItem, summary: Summary): Promise<void> {
  const { shopId, status, adapter } = item;
  const tag = `${shopId}:${adapter.platform}`;
  const sb = getSupabase();
  const source = await adapter.connect(shopId);
  if (!source) {
    summary.skipped.push(tag);
    return;
  }
  const now = new Date().toISOString();
  try {
    if (status === "pending") {
      await backfillAds(source, adapter.platform, shopId, sb);
      await setSync(shopId, adapter.integrationKind, { sync_status: "live", sync_error: null, last_sync_at: now });
      summary.backfilled.push(tag);
    } else {
      await pollAdsDaily(source, adapter.platform, shopId, sb);
      // A successful poll must reset sync_status to "live", not just clear the
      // error message — otherwise a row that previously hit "error" stays in
      // error state forever even after polls succeed (no other path flips it).
      await setSync(shopId, adapter.integrationKind, { sync_status: "live", sync_error: null, last_sync_at: now });
      summary.polled.push(tag);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort error-status write: never let a failed status update mask the
    // original ingestion error (which must reach the pool below).
    try {
      await setSync(shopId, adapter.integrationKind, { sync_status: "error", sync_error: message.slice(0, 500) });
    } catch (statusErr) {
      console.error(`[cron.ingest-ads] failed to record sync error for ${tag}`, statusErr);
    }
    throw err; // re-thrown into the isolated pool slot; recorded below
  }
}

interface Summary {
  backfilled: string[];
  polled: string[];
  skipped: string[];
  errors: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const work = await adaptersForShops(sb);
  const summary: Summary = { backfilled: [], polled: [], skipped: [], errors: [] };

  const settled = await mapWithConcurrency(work, CONCURRENCY, (item) => runOne(item, summary));
  settled.forEach((r, i) => {
    if (!r.ok) {
      const item = work[i];
      const message = r.error instanceof Error ? r.error.message : String(r.error);
      summary.errors.push(`${item.shopId}:${item.adapter.platform}: ${message}`);
      console.error(`[cron.ingest-ads] sync failed for ${item.shopId}:${item.adapter.platform}`, r.error);
    }
  });

  return json(summary);
};
