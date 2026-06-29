// app/routes/dashboard.api.campaigns.$id.creatives.tsx
// GET → the campaign's Meta ad creatives + CACHED per-ad scorecards (no scoring).
// The dashboard CampaignDetail calls this on open, like fetchCampaignDirection.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadCampaignCreativeScorecards } from "~/lib/screener/campaign-creatives-load.server";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const spend = Number(url.searchParams.get("assumedSpendCents")) || DEFAULT_SPEND_CENTS;
  return dashboardJson(async () =>
    loadCampaignCreativeScorecards(session.shopId, session.shopId, String(params.id), spend),
  );
}
