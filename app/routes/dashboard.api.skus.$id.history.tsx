// GET /dashboard/api/skus/:id/history — dashboard mirror of the per-SKU stock
// trend. Same data contract as the extension's app.skus.$skuId.history loader.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  // Boundary validation: a non-uuid id can't match — return empty, don't query.
  const skuId = String(params.id ?? "");
  return dashboardJson(async () => ({
    history: isUuid(skuId)
      ? await calderynClient(session.shopId).skus.history(skuId)
      : [],
  }));
}
