// app/routes/dashboard.api.orders.$id.resend-invoice.tsx
// POST -> resendInvoiceEmail (orders phase 3, Task 5): re-send the pay-link email for an unpaid
// invoice order. Native orders only; the pay link's confirmation_token never changes across a
// resend, so this replays sendInvoiceEmail off the order's current lines/total.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { resendInvoiceEmail } from "~/lib/order/invoice.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders have no invoice to resend.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  return dashboardJson(async () => {
    const result = await resendInvoiceEmail(session.shopId, orderId);
    return { sent: result.sent, reason: result.reason };
  });
}
