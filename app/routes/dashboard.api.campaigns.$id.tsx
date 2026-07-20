import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import {
  dashboardJson,
  jsonError,
  parseJsonObjectBody,
  requireSameOrigin,
} from "~/lib/dashboard/http.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { resolveCampaignScore } from "~/lib/campaign-score/resolve.server";
import { loadCampaignCreativeScorecards } from "~/lib/screener/campaign-creatives-load.server";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";
import { getSupabase } from "~/lib/supabase.server";

type CampaignClassificationInput =
  | { campaignKind: "regular"; saleType?: never }
  | { campaignKind: "sales"; saleType: string };

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "PATCH") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "invalid_body");
  if (Object.keys(body).some((key) => key !== "campaignKind" && key !== "saleType")) {
    return jsonError(400, "invalid_classification");
  }

  let input: CampaignClassificationInput;
  if (body.campaignKind === "regular" && body.saleType === undefined) {
    input = { campaignKind: "regular" };
  } else if (body.campaignKind === "sales" && typeof body.saleType === "string") {
    const saleType = body.saleType.trim();
    if (saleType.length < 1 || saleType.length > 80) {
      return jsonError(400, "invalid_sale_type");
    }
    input = { campaignKind: "sales", saleType };
  } else {
    return jsonError(400, "invalid_classification");
  }

  return dashboardJson(async () => {
    const update = {
      campaign_kind: input.campaignKind,
      sale_type: input.campaignKind === "sales" ? input.saleType : null,
      classification_source: "merchant",
    };
    const { data, error } = await getSupabase()
      .from("ad_campaign_dim")
      .update(update)
      .eq("id", String(params.id))
      .eq("shop_id", session.shopId)
      .select("campaign_kind, sale_type, classification_source")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new CalderynError({
        code: "campaign_not_found",
        status: 404,
        message: "Campaign not found.",
      });
    }
    return { campaign: data };
  });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopId);
    const [campaign, grades, creativeData] = await Promise.all([
      client.campaigns.get(id),
      client.analytics.campaignGrades(),
      // Cache-ONLY read of the campaign's creatives + per-ad scorecards — NO
      // Claude/scoring on load. Uncached ads are scored on demand via the score
      // endpoint; here we only need the cached half to blend.
      loadCampaignCreativeScorecards(session.shopId, session.shopId, id, DEFAULT_SPEND_CENTS),
    ]);
    const gradeRow = grades.find((g) => g.campaign_id === id);
    const { creatives, scorecards } = creativeData;
    // Full-blend detail score (parity with the embedded detail): performance half
    // from the grade row, creative half from the campaign's ACTIVE ads' cached
    // scorecards. Inject the already-loaded scorecards as deps so resolve does no
    // second cache read. The list loader stays performance-only as a cost guard.
    const calderynScore = await resolveCampaignScore(
      session.shopId,
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
