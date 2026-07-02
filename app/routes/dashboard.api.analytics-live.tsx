// app/routes/dashboard.api.analytics-live.tsx
// Live View snapshot for the dashboard Analytics screen. GET-only resource
// route; named analytics-live (not analytics.live) so it stays a sibling of
// the existing analytics resource route instead of nesting under it.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { buildLiveSnapshot } from "~/lib/dashboard/live-analytics.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => buildLiveSnapshot(getSupabase(), session.shopId));
}
