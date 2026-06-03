import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { runBudgetLoopForShop } from "~/lib/budget/loop.server";

const MAX_SHOPS = 10; // bounded per tick to stay under the function timeout

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    shopsProcessed: 0,
    cutsApplied: 0,
    feedsApplied: 0,
    freedCents: 0,
    blocked: 0,
    campaignErrors: 0,
    alertsUpserted: 0,
    alertsResolved: 0,
    errors: [] as string[],
  };

  const { data: shops } = await sb
    .from("shop_integrations")
    .select("shops!inner(shop_domain)")
    .eq("kind", "meta_ads")
    .eq("sync_status", "ready")
    .limit(MAX_SHOPS);

  for (const row of shops ?? []) {
    const domain = (row as unknown as { shops: { shop_domain: string } }).shops.shop_domain;
    try {
      const r = await runBudgetLoopForShop(domain);
      summary.shopsProcessed += 1;
      summary.cutsApplied += r.cutsApplied;
      summary.feedsApplied += r.feedsApplied;
      summary.freedCents += r.freedCents;
      summary.blocked += r.blocked;
      summary.campaignErrors += r.campaignErrors;
      summary.alertsUpserted += r.alertsUpserted;
      summary.alertsResolved += r.alertsResolved;
    } catch (err) {
      // One shop's failure must not deny the rest their reallocation.
      summary.errors.push(domain);
      console.error(`[cron.budget-loop] failed for ${domain}`, err);
    }
  }

  return json(summary);
};
