// Daily Search Console pull for every connected shop. Idempotent (upserts on
// the natural key), per-shop failure isolation, 50s time budget. Shops are
// drained in gsc_last_pulled_at order (nulls, i.e. never-pulled shops, first)
// so a run that hits the time budget leaves the skipped shops at the front of
// the next run's queue instead of starving the same tail shops every time.
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { pullShopRankings } from "~/lib/seo/search-console.server";
import { getSupabase } from "~/lib/supabase.server";

const TIME_BUDGET_MS = 50_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const { data, error } = await getSupabase()
    .from("seo_settings")
    .select("shop_id, gsc_last_pulled_at")
    .eq("gsc_connected", true)
    .order("gsc_last_pulled_at", { ascending: true, nullsFirst: true });
  if (error) return json({ error: error.message }, { status: 500 });
  let pulled = 0;
  let failed = 0;
  let skipped = false;
  for (const row of data ?? []) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      skipped = true;
      break;
    }
    try {
      await pullShopRankings(row.shop_id);
      pulled++;
    } catch (err) {
      failed++;
      console.error(`[cron.seo-rankings] shop ${row.shop_id} failed`, err);
    }
  }
  return json({ pulled, failed, skipped });
};
