// Weekly competitor auto-discovery. Same resumable-drain shape as
// cron.radar-collect: radar_discovery_queue orders by
// radar_state.last_discovered_at (nulls first) and discoverShopCompetitors
// stamps the cursor on success, so a budget-stopped run resumes next week
// where it left off and never starves the tail. One quota-gated Claude
// web_search call per shop; a failed shop logs and never halts the queue.
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { discoverShopCompetitors } from "~/lib/radar/discovery.server";
import { getSupabase } from "~/lib/supabase.server";

const TIME_BUDGET_MS = 50_000;

// The loop budgets 50s of work; give the function headroom past the default
// so a run that uses its full budget is not killed mid-shop.
export const config = { maxDuration: 60 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const { data, error } = await getSupabase().rpc("radar_discovery_queue", { p_limit: 200 });
  if (error) return json({ error: `radar_discovery_queue: ${error.message}` }, { status: 500 });
  let suggested = 0;
  let skippedShops = 0;
  let failed = 0;
  let budgetStopped = false;
  for (const row of (data ?? []) as Array<{ shop_id: string }>) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      budgetStopped = true;
      break;
    }
    try {
      const out = await discoverShopCompetitors(row.shop_id);
      if ("suggested" in out) suggested += out.suggested;
      else skippedShops++;
    } catch (err) {
      failed++;
      console.error(`[cron.radar-discover] shop ${row.shop_id} failed`, err);
    }
  }
  console.log(`[cron.radar-discover] suggested ${suggested}, skipped ${skippedShops}, failed ${failed} in ${Date.now() - started}ms`);
  return json({ suggested, skippedShops, failed, budgetStopped });
};
