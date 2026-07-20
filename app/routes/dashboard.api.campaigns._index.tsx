import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { resolveCampaignScore } from "~/lib/campaign-score/resolve.server";
import type { CampaignWindow } from "~/lib/types";

const CAMPAIGN_WINDOWS = new Set(["7", "30", "90"]);

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const rawWindow = new URL(request.url).searchParams.get("window") ?? "30";
  if (!CAMPAIGN_WINDOWS.has(rawWindow)) return jsonError(400, "invalid_window");
  const window = Number(rawWindow) as CampaignWindow;

  return dashboardJson(async () => {
    const client = calderynClient(session.shopId);
    const [campaigns, grades] = await Promise.all([
      client.campaigns.performance(window),
      client.analytics.campaignGrades(),
    ]);
    const gradeById = new Map(grades.map((g) => [g.campaign_id, g]));
    // Performance-only list score: no per-campaign creative fetch on list render
    // (rule 6 cost guard). ads:[] ⇒ resolve does no creative I/O. The creative
    // half is blended on the detail page, which loads each campaign's cached
    // scorecards. Uncached/no-grade campaigns resolve to band "nodata" ⇒ ScorePill
    // renders "Score pending".
    const withScore = await Promise.all(
      campaigns.map(async (c) => ({
        ...c,
        calderynScore: await resolveCampaignScore(
          session.shopId,
          { id: c.id, ads: [] },
          gradeById.get(c.id),
        ),
      })),
    );
    return { campaigns: withScore };
  });
}
