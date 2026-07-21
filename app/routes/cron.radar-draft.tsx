// Nightly Radar drafting, scheduled after radar-collect (and after the
// seo-rankings pull) so detectors see tonight's data. Same cursor-fairness
// resumable drain; a failed shop logs and never halts the queue.
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { draftShopMoves } from "~/lib/radar/draft.server";
import { getSupabase } from "~/lib/supabase.server";

const TIME_BUDGET_MS = 50_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const { data, error } = await getSupabase().rpc("radar_shop_queue", { p_for: "draft", p_limit: 500 });
  if (error) return json({ error: `radar_shop_queue: ${error.message}` }, { status: 500 });
  let drafted = 0;
  let expired = 0;
  let failed = 0;
  let skipped = false;
  for (const row of (data ?? []) as Array<{ shop_id: string }>) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      skipped = true;
      break;
    }
    try {
      const summary = await draftShopMoves(row.shop_id);
      drafted += summary.drafted;
      expired += summary.expired;
    } catch (err) {
      failed++;
      console.error(`[cron.radar-draft] shop ${row.shop_id} failed`, err);
    }
  }
  console.log(`[cron.radar-draft] drafted ${drafted}, expired ${expired}, failed ${failed} in ${Date.now() - started}ms`);
  return json({ drafted, expired, failed, skipped });
};
