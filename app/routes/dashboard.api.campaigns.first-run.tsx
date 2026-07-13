import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { firstRunPreflight } from "~/lib/meta/first-run.server";

// GET: Meta preflight for the first-campaign wizard (connected/scope/page/funding).
// A POST action for the wizard's create step arrives in a later task.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => firstRunPreflight(session.shopId, getSupabase()));
}
