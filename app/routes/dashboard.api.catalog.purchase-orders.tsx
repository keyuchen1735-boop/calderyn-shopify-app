import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { listPurchaseOrders } from "~/lib/catalog/po-list.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  return dashboardJson(() =>
    listPurchaseOrders(session.shopId, {
      offset: Number(url.searchParams.get("offset") ?? 0) || 0,
    }),
  );
}
