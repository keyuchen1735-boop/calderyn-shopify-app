// Poll cron for the 3PL / carrier ship-cost connector (contract C3). Structural twin
// of cron.ingest-ads.tsx: bearer-auth, bounded fan-out across (shop × adapter), per-slot
// error isolation. Per shop: connect → fetch a TRAILING re-pull window of charges →
// land them under the synthetic connector period → flip sync bookkeeping → re-resolve
// ship cost so matched orders read actual_invoice/high.
//
// Plain Remix loader route (like the other 9 crons) — it is NOT a function path, so it
// does not collide with the api/* Python or .well-known function paths behind the recent
// prod 501 incidents (commits 551dabf / b486895). Registered in vercel.json `crons`.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { shipAdaptersForShops, type ShipWorkItem } from "~/lib/ship-cost/adapters/registry.server";
import { landShipmentCharges } from "~/lib/ship-cost/adapters/land.server";
import { runShipCostResolution } from "~/lib/ship-cost/runner.server";
import { mapWithConcurrency } from "~/lib/ads/concurrency";

const CONCURRENCY = 4; // bounded fan-out across shops × adapters (mirror cron.ingest-ads).

// Carrier costs settle/adjust post-ship, so even the daily poll re-pulls a trailing
// window rather than only "since last sync". The landing pipeline replaces rows in this
// window idempotently (delete-by-external-id then insert), so re-pulling is safe.
const REPULL_WINDOW_DAYS = 30;

function trailingWindowSince(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

async function setSync(shopId: string, kind: string, patch: Record<string, unknown>): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();
  // supabase-js returns { error } without throwing; a silently-dropped status write on
  // the success path would report a sync that never persisted (stale 'ready' → endless
  // re-pull, or a missed last_sync_at). Throw so the pool records it as a real failure.
  const { error } = await sb
    .from("shop_integrations")
    .update({ ...patch, updated_at: now })
    .eq("shop_id", shopId)
    .eq("kind", kind);
  if (error) throw error;
}

interface Summary {
  landed: string[];
  skipped: string[];
  errors: string[];
}

async function runOne(item: ShipWorkItem, summary: Summary): Promise<void> {
  const { shopId, adapter } = item;
  const tag = `${shopId}:${adapter.provider}`;
  const sb = getSupabase();

  const source = await adapter.connect(shopId);
  if (!source) {
    // No usable credential → not an error, just nothing to do for this shop.
    summary.skipped.push(tag);
    return;
  }

  const now = new Date().toISOString();
  try {
    const since = trailingWindowSince(REPULL_WINDOW_DAYS);
    const charges = await source.fetchCharges(since);
    const result = await landShipmentCharges(sb, shopId, adapter.provider, charges);

    // A successful pull flips a freshly-'ready' shop (or a previously-errored one) to
    // 'live' and clears any prior error — no other path resets it (mirror ad cron).
    await setSync(shopId, adapter.integrationKind, {
      sync_status: "live",
      sync_error: null,
      last_sync_at: now,
    });
    // Re-resolve AFTER landing so matched orders pick up actual_invoice/high. shopCountry
    // is null here, matching the CSV/typed callers (the getShopCountry stub degrades
    // allocation gracefully; actual_invoice is exact regardless — runner.server.ts:31-33).
    await runShipCostResolution(sb, shopId, { shopCountry: null });

    summary.landed.push(
      `${tag} matched=${result.matchedLineCount} unmatched=${result.unmatchedCount} skipped=${result.skippedNoKeyCount} dupes=${result.duplicateExternalIdCount}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort error-status write; never let a failed status update mask the original
    // ingestion error (which must reach the pool below).
    try {
      await setSync(shopId, adapter.integrationKind, {
        sync_status: "error",
        sync_error: message.slice(0, 500),
      });
    } catch (statusErr) {
      console.error(`[cron.ingest-ship-costs] failed to record sync error for ${tag}`, statusErr);
    }
    throw err; // re-thrown into the isolated pool slot; recorded below.
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const work = await shipAdaptersForShops(sb);
  const summary: Summary = { landed: [], skipped: [], errors: [] };

  const settled = await mapWithConcurrency(work, CONCURRENCY, (item) => runOne(item, summary));
  settled.forEach((r, i) => {
    if (!r.ok) {
      const item = work[i];
      const message = r.error instanceof Error ? r.error.message : String(r.error);
      summary.errors.push(`${item.shopId}:${item.adapter.provider}: ${message}`);
      console.error(
        `[cron.ingest-ship-costs] sync failed for ${item.shopId}:${item.adapter.provider}`,
        r.error,
      );
    }
  });

  return json(summary);
};
