// Onboarding-journey "place a test order" milestone (Task 10). POST {intent}:
// "start" originates a 50c probe order and returns the Stripe Checkout url;
// "confirm" (called on the success return leg) stamps the milestone once a
// paid-ish probe exists, then refunds it — unless the shop is mid go-live
// cutover, whose own probe accounting (dual_run's startTestTransaction /
// refundTestOrders pair) must never be disturbed by this unrelated flow.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { startJourneyTestOrder, refundTestOrders } from "~/lib/cutover/test-transaction.server";
import { getOrgMode } from "~/lib/cutover/org-mode.server";
import { recomputeJourney } from "~/lib/onboarding/journey.server";
import { getSupabase } from "~/lib/supabase.server";

const PAID_ISH_STATES = ["paid", "fulfilled", "refunded", "partially_refunded"];

export async function action({ request }: ActionFunctionArgs) {
  // The validated origin doubles as the Stripe return host — the dashboard Home
  // screen on the host the merchant's session cookie lives on (same idiom as
  // the go-live probe's cutover-test-transaction route).
  const origin = requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (body === null) return jsonError(400, "bad_body");

  if (body.intent === "start") {
    return dashboardJson(() => startJourneyTestOrder(session.shopId, origin));
  }

  if (body.intent === "confirm") {
    return dashboardJson(async () => {
      // Paid probe? Stamp the milestone, then refund the 50c (idempotent: a
      // re-POST with no new paid probe since the last refund is a harmless no-op).
      const { count, error } = await getSupabase()
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", session.shopId)
        .eq("channel", "test")
        .in("state", PAID_ISH_STATES);
      if (error) throw error;
      const confirmed = (count ?? 0) > 0;
      if (confirmed) {
        await recomputeJourney(session.shopId);
        // Never disturb a real cutover's probe accounting: dual_run's own
        // go-live gate refunds its test orders itself on the -> live transition.
        const mode = await getOrgMode(session.shopId);
        if (mode !== "dual_run") {
          await refundTestOrders(session.shopId, getSupabase()); // logs + swallows per its contract
        }
      }
      return { confirmed };
    });
  }

  return jsonError(422, "invalid_intent");
}
