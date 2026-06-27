import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { resolveCampaignScore } from "~/lib/campaign-score/resolve.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopDomain);
    const [campaign, grades] = await Promise.all([
      client.campaigns.get(id),
      client.analytics.campaignGrades(),
    ]);
    const gradeRow = grades.find((g) => g.campaign_id === id);
    // Phase 1: performance-led detail score (creative half + per-ad scorecards
    // land with the dashboard creatives port in Phase 2). ads:[] ⇒ no creative
    // I/O; the score breakdown shows P, confidence, and 0/0 coverage today.
    const calderynScore = await resolveCampaignScore(session.shopDomain, { id, ads: [] }, gradeRow);
    return { campaign: { ...campaign, calderynScore } };
  });
}
