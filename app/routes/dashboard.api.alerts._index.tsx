import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const sp = new URL(request.url).searchParams;
  return dashboardJson(async () => ({
    alerts: await calderynClient(session.shopDomain).alerts.list({
      status: sp.get("status") ?? undefined,
      severity: sp.get("severity") ?? undefined,
      detector: sp.get("detector") ?? undefined,
    }),
  }));
}
