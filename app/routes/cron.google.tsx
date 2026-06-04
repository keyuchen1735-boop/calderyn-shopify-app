import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { googleClientForShop } from "~/lib/google/client.server";
import { backfillGoogle, pollGoogleDaily } from "~/lib/google/ingest.server";

const MAX_GOOGLE_SHOPS = 5; // bounded per tick to stay under function timeout

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    backfilled: [] as string[],
    polled: [] as string[],
    skipped: [] as string[],
    errors: [] as string[],
  };

  const { data: rows } = await sb
    .from("shop_integrations")
    .select("shop_id, sync_status")
    .eq("kind", "google_ads")
    .in("sync_status", ["pending", "live"])
    .limit(MAX_GOOGLE_SHOPS);

  // Per-shop isolation: one shop's failure (including the credential-decrypt
  // throw from googleClientForShop) must be caught and recorded, never aborting
  // the remaining shops, never silently passing (rule 12).
  for (const row of rows ?? []) {
    const shopId = String(row.shop_id);
    const status = String(row.sync_status);
    try {
      const conn = await googleClientForShop(shopId);
      if (!conn) {
        // No integration / no credentials yet — nothing to do for this shop.
        summary.skipped.push(shopId);
        continue;
      }
      if (status === "pending") {
        await backfillGoogle(conn.client, shopId, sb);
        summary.backfilled.push(shopId);
      } else {
        await pollGoogleDaily(conn.client, shopId, sb);
        summary.polled.push(shopId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${shopId}: ${message}`);
      console.error(`[cron.google] sync failed for shop ${shopId}`, err);
    }
  }

  return json(summary);
};
