import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = params.id;
  if (!id) return jsonError(422, "missing_campaign_id");
  const days = Math.min(
    Math.max(Number(new URL(request.url).searchParams.get("days")) || 90, 7),
    180,
  );
  return dashboardJson(async () => {
    const client = calderynClient(session.shopId);
    return { series: await client.analytics.campaignRoasSeries(id, days) };
  });
}
