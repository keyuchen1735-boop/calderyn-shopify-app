// POST → run autopilot IMMEDIATELY for the session's shop and return the
// structured summary (acted/blocked/failed/considered + per-candidate decisions).
//
// This is the immediate path the dashboard fires on load when autopilot is
// enabled, so the merchant sees actions land now instead of at the next cron
// tick. /cron/autopilot is the same engine on a 0,30 * * * * timer — the
// "when the dashboard is closed" backstop. Both call runAutopilotForShop, which
// is idempotent (executeAction keys off autopilot:<alert>:<kind>), so a re-run
// no-ops on already-handled alerts. The engine itself returns { skipped:true }
// when autopilot is disabled, so this route is a safe no-op in that case too.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { runAutopilotForShop } from "~/lib/actions/autopilot.server";
import { getSupabase } from "~/lib/supabase.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  return dashboardJson(async () => runAutopilotForShop(session.shopId, getSupabase()));
}
