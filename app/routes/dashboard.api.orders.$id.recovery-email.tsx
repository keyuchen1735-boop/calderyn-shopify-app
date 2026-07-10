import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, nativeOrderExists, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { sendRecoveryEmail } from "~/lib/order/recovery.server";

/**
 * Merchant-initiated resend of the abandoned-checkout recovery email (orders phase 3, Task 4).
 * Native orders only — imported orders never carry a native checkout to recover. Delegates every
 * eligibility rule (channel/state, consent, buyer email) to sendRecoveryEmail so the manual button
 * can never send an email the automatic sweep itself would refuse to send.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders have no recovery email to send.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  return dashboardJson(async () => {
    if (!(await nativeOrderExists(session.shopId, orderId))) {
      throw jsonError(404, "order_not_found");
    }
    const result = await sendRecoveryEmail(session.shopId, orderId, { manual: true });
    return { sent: result.sent, reason: result.reason };
  });
}
