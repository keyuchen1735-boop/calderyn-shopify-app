import type { LoaderFunctionArgs } from "@remix-run/node";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { loadOperatingPnl } from "~/lib/analytics/operating-pnl.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const raw = Number(new URL(request.url).searchParams.get("days"));
  // 3650 is the "All time" window — QuickBooks reports need a concrete start
  // date, so ten years stands in for company-lifetime.
  const days = [7, 14, 30, 90, 365, 3650].includes(raw) ? raw : 30;
  return dashboardJson(() => loadOperatingPnl(session.shopId, days));
}
