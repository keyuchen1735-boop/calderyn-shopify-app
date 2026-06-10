import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    alert: await calderynClient(session.shopDomain).alerts.get(String(params.id)),
  }));
}
