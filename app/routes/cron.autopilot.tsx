import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { mapWithConcurrency } from "~/lib/ads/concurrency";
import { runAutopilotForShop } from "~/lib/actions/autopilot.server";

const CONCURRENCY = 4;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sb = getSupabase();
  const summary = { acted: 0, blocked: 0, failed: 0, shops: 0, errors: [] as string[] };

  // Surface a shop-list read failure as a 500 instead of swallowing it: a DB
  // outage must not look identical to "no shops opted in" (an empty 200), which
  // a cron monitor would read as a healthy run.
  const { data: rows, error: listErr } = await sb
    .from("guardrail_config")
    .select("shop_id")
    .eq("autopilot_enabled", true);
  if (listErr) {
    console.error("[cron.autopilot] failed to list autopilot shops", listErr);
    return json({ error: `failed to list autopilot shops: ${listErr.message}` }, { status: 500 });
  }
  const shopIds = (rows ?? []).map((r) => String(r.shop_id));

  const settled = await mapWithConcurrency(shopIds, CONCURRENCY, (shopId) => runAutopilotForShop(shopId, sb));
  settled.forEach((r, i) => {
    if (r.ok) {
      summary.shops += 1;
      summary.acted += r.value.acted;
      summary.blocked += r.value.blocked;
      summary.failed += r.value.failed;
    } else {
      const message = r.error instanceof Error ? r.error.message : String(r.error);
      summary.errors.push(`${shopIds[i]}: ${message}`);
      console.error(`[cron.autopilot] failed for ${shopIds[i]}`, r.error);
    }
  });
  return json(summary);
};
