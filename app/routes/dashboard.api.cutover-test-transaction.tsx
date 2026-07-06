import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { startTestTransaction } from "~/lib/cutover/test-transaction.server";

// POST: originate a go-live test transaction for the signed-in shop and return the Stripe
// Checkout url the merchant completes. Guards (dual_run, Stripe connected) live in
// startTestTransaction and throw plain Errors; we map them to a 400 carrying the message
// verbatim so the dashboard can show it (dashboardJson would otherwise lose it in a 500).
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  try {
    const { url } = await startTestTransaction(session.shopId);
    return dashboardJson(async () => ({ url }));
  } catch (err) {
    const message = err instanceof Error ? err.message : "could not start test transaction";
    return jsonError(400, "test_transaction_failed", message);
  }
}
