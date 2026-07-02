// GET /dashboard/api/skus/:id/affinity — dashboard mirror of "frequently bought
// with". Same data contract as the extension's app.skus.$skuId.affinity loader.
import type { LoaderFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const skuId = String(params.id ?? "");
  return dashboardJson(async () => ({
    affinity: isUuid(skuId)
      ? await calderynClient(session.shopId).skus.affinity(skuId)
      : [],
  }));
}
