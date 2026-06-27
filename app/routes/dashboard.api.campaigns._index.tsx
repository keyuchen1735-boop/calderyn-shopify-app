import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { resolveCampaignScore } from "~/lib/campaign-score/resolve.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopDomain);
    const [campaigns, grades] = await Promise.all([
      client.campaigns.list(),
      client.analytics.campaignGrades(),
    ]);
    const gradeById = new Map(grades.map((g) => [g.campaign_id, g]));
    // Performance-led list score: no per-campaign creative fetch on list render
    // (rule 6 cost guard). ads:[] ⇒ resolve does no creative I/O. The creative
    // half resolves on the detail page (Phase 2 ports the dashboard creatives
    // fetch). Uncached/no-grade campaigns resolve to band "nodata" ⇒ ScorePill
    // renders "Score pending".
    const withScore = await Promise.all(
      campaigns.map(async (c) => ({
        ...c,
        calderynScore: await resolveCampaignScore(
          session.shopDomain,
          { id: c.id, ads: [] },
          gradeById.get(c.id),
        ),
      })),
    );
    return { campaigns: withScore };
  });
}
