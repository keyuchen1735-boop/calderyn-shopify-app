import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { getSupabase } from "~/lib/supabase.server";
import { metaDraftPushEnabled } from "~/lib/meta/ad-create.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopId);
    const [roasSeries, grades, topAds] = await Promise.all([
      client.analytics.dailyRoasSeries(30),
      client.analytics.campaignGrades(),
      client.analytics.topAdsByEngagement(30, 10),
    ]);
    return {
      roas_series: roasSeries,
      grades,
      top_ads: topAds,
      meta_can_push_drafts: await metaDraftPushEnabled(getSupabase(), session.shopId),
    };
  });
}
