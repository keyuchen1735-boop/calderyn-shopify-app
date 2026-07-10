// Unified order-detail read (Task 10): serves both the native checkout spine and the
// imported (Shopify-paid, read-only) history through loadOrderDetail's single OrderDetail
// contract (Task 9) — this route never branches on source, that's the read model's job.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError } from "~/lib/dashboard/http.server";
import { loadOrderDetail } from "~/lib/order/detail.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    const detail = await loadOrderDetail(session.shopId, id);
    if (!detail) throw jsonError(404, "order_not_found");
    return { order: detail };
  });
}
