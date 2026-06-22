import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopDomain);
    const [cal, nearGraduation] = await Promise.all([
      client.calibration.get(request.signal),
      client.calibration.nearGraduation(),
    ]);
    return { pct: cal.pct, updated_at: cal.updated_at, nearGraduation };
  });
}
