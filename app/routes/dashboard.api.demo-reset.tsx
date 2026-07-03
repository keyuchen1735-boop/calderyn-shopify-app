import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { rateLimit } from "~/lib/rate-limit.server";
import { getSupabase } from "~/lib/supabase.server";
import { resetDemoShowcase } from "~/lib/demo/reset.server";

// POST: wipe the signed-in DEMO shop back to its seeded opening scene. The
// orchestrator re-checks shops.demo_mode itself (409 not_demo_shop otherwise),
// so a real shop can never reach the wipe even if the UI gate regresses. A
// reset takes a few seconds; the limiter absorbs double-clicks racing two wipes.
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  if (!(await rateLimit(`demo-reset:${session.shopId}`, 1, 60_000))) {
    return jsonError(429, "rate_limited", "A reset just ran. Give it a minute.");
  }
  return dashboardJson(async () => {
    const summary = await resetDemoShowcase(session.shopId, getSupabase());
    return { ok: true, summary };
  });
}
