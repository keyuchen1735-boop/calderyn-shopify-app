import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { resolveCampaignScore } from "~/lib/campaign-score/resolve.server";
import { loadCampaignCreativeScorecards } from "~/lib/screener/campaign-creatives-load.server";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopDomain);
    const [campaign, grades, creativeData] = await Promise.all([
      client.campaigns.get(id),
      client.analytics.campaignGrades(),
      // Cache-ONLY read of the campaign's creatives + per-ad scorecards — NO
      // Claude/scoring on load. Uncached ads are scored on demand via the score
      // endpoint; here we only need the cached half to blend.
      loadCampaignCreativeScorecards(session.shopDomain, session.shopId, id, DEFAULT_SPEND_CENTS),
    ]);
    const gradeRow = grades.find((g) => g.campaign_id === id);
    const { creatives, scorecards } = creativeData;
    // Full-blend detail score (parity with the embedded detail): performance half
    // from the grade row, creative half from the campaign's ACTIVE ads' cached
    // scorecards. Inject the already-loaded scorecards as deps so resolve does no
    // second cache read. The list loader stays performance-only as a cost guard.
    const calderynScore = await resolveCampaignScore(
      session.shopDomain,
      {
        id,
        ads: creatives.map((cr) => ({
          adId: cr.adId,
          status: cr.status.toUpperCase() === "PAUSED" ? "paused" : "active",
        })),
      },
      gradeRow,
      { loadCachedAdScorecards: async (_s, ids) => scorecards.filter((sc) => ids.includes(sc.adId)) },
    );
    return { campaign: { ...campaign, calderynScore } };
  });
}
