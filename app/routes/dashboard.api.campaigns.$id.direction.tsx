// GET → the campaign's recommended direction + plain-English why (dashboard parity
// with the embedded detail). Same shared recommender + reasoning + cache.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { getSupabase } from "~/lib/supabase.server";
import { resolveCampaignDirection } from "~/lib/actions/direction-reason.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  const client = calderynClient(session.shopDomain);
  const [campaign, openAlerts, guardrails] = await Promise.all([
    client.campaigns.get(id),
    client.alerts.list({ status: "open" }).catch(() => []),
    client.guardrails.get().catch(() => null),
  ]);
  const breakEvenRoas = campaign.contribution_margin > 0 ? 1 / campaign.contribution_margin : null;
  return dashboardJson(async () =>
    resolveCampaignDirection({
      shopId: session.shopId,
      campaignId: campaign.id,
      roas: campaign.roas_7d > 0 ? campaign.roas_7d : null,
      breakEvenRoas,
      status: campaign.status,
      currentBudgetCents: campaign.daily_budget_cents,
      alerts: openAlerts.map((a) => ({ detector_id: a.detector_id, status: a.status, campaign_id: a.campaign_id })),
      guardrails: guardrails ?? {},
      sb: getSupabase(),
    }),
  );
}
