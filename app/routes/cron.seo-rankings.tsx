// app/routes/cron.seo-rankings.tsx
// Daily Google Search Console pull. For each shop that has connected GSC, sync
// its Search Analytics into seo_ranking (idempotent on shop+query+page+date).
// Per-shop failures are isolated so one dead token never aborts the sweep.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { listConnectedShopIds, syncRankings } from "~/lib/seo/google-search-console.server";

interface Summary {
  synced: Array<{ shopId: string; upserted: number }>;
  errors: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const summary: Summary = { synced: [], errors: [] };
  const shopIds = await listConnectedShopIds();

  for (const shopId of shopIds) {
    try {
      const { upserted } = await syncRankings(shopId);
      summary.synced.push({ shopId, upserted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${shopId}: ${message}`);
      console.error(`[cron.seo-rankings] sync failed for ${shopId}`, err);
    }
  }

  return json(summary);
};
