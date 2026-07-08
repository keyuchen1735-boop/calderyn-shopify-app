// app/routes/dashboard.api.store.samples.tsx
// POST -> archive every active calderyn:sample product (the studio chip's one-click "replace with
// your own", design §3.6). Archival is the canonical delete path: reversible, drops the samples
// from the active storefront and the studio preview, no FK cascade. dashboardJson shapes a thrown
// tag-query error into a clean JSON error rather than reporting a false success (rule 12).
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, requireSameOrigin } from "~/lib/dashboard/http.server";
import { clearSampleProducts } from "~/lib/storegen/seed.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const removed = await clearSampleProducts(session.shopId);
    return { removed };
  });
}
