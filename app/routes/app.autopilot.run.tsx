// POST → run autopilot IMMEDIATELY for the embedded admin's shop and return the
// structured summary (acted/blocked/failed/considered + per-candidate decisions).
//
// Extension-side parity with /dashboard/api/autopilot: the embedded home page
// (app._index) fires this on load when autopilot is enabled, so the merchant
// sees actions land now instead of at the next cron tick. Same engine as the
// /cron/autopilot 0,30 backstop and the dashboard; idempotent (executeAction
// keys off autopilot:<alert>:<kind>), so a re-run no-ops on already-handled
// alerts, and runAutopilotForShop returns { skipped:true } when disabled.
//
// Resource route: action only (no loader/component). App Bridge session-token
// auth via authenticate.admin replaces the dashboard route's cookie+CSRF guard.

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { runAutopilotForShop } from "~/lib/actions/autopilot.server";

export async function action({ request }: ActionFunctionArgs) {
  // authenticate.admin throws an App Bridge re-auth Response — must propagate so
  // the embedded iframe re-authenticates; never caught below.
  const { session } = await authenticate.admin(request);
  try {
    const shopId = await resolveShopId(session.shop);
    return json(await runAutopilotForShop(shopId, getSupabase()));
  } catch (err) {
    if (err instanceof Response) throw err;
    // Fail visibly (rule 12) but as DATA, not a throw: a thrown action error
    // would bubble to the root ErrorBoundary and replace the home page. The
    // engine already logs + the home page surfaces this message quietly.
    console.error("[app.autopilot.run] failed", err);
    const message = err instanceof Error ? err.message : "Autopilot run failed";
    return json({ skipped: false, acted: 0, considered: 0, decisions: [], error: message });
  }
}
