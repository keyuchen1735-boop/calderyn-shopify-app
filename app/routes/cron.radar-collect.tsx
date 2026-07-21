// Nightly Radar collection: per-shop traffic rollup with cursor fairness.
// radar_shop_queue orders by radar_state.last_collected_at (nulls first), and
// collectShop stamps the cursor on success - so a run that dies at the time
// budget resumes exactly where it stopped, and no shop is ever starved (the
// same resumable-drain shape as cron.import / cron.seo-rankings).
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { collectShop } from "~/lib/radar/collect.server";
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
  const { data, error } = await getSupabase().rpc("radar_shop_queue", { p_for: "collect", p_limit: 500 });
  if (error) return json({ error: `radar_shop_queue: ${error.message}` }, { status: 500 });
  let collected = 0;
  let failed = 0;
  let skipped = false;
  for (const row of (data ?? []) as Array<{ shop_id: string }>) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      skipped = true;
      break;
    }
    try {
      await collectShop(row.shop_id, started + TIME_BUDGET_MS);
      collected++;
    } catch (err) {
      failed++;
      console.error(`[cron.radar-collect] shop ${row.shop_id} failed`, err);
    }
  }
  console.log(`[cron.radar-collect] collected ${collected}, failed ${failed} in ${Date.now() - started}ms`);
  return json({ collected, failed, skipped });
};
