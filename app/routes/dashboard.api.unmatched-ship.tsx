// GET → { count, items: [{ id, provider, orderRef, trackingNo, costCents, externalChargeId, reason }] }
//
// Dashboard mirror of the embedded "unmatched carrier charges" surface (Phase 3 Part C),
// READ-ONLY: the dashboard shows the count + list, but mapping a charge to an order stays
// embedded-admin-only (connect/disconnect + write actions live in the Shopify app — the
// same split the dashboard uses for integrations). Reuses the stack-agnostic
// getUnmatchedCharges reader (the C.1 contract); sb + shopId resolved directly like the
// other dashboard read routes (ship-cost, integrations).

import type { LoaderFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { getUnmatchedCharges } from "~/lib/ship-cost/unmatched.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const sb = getSupabase();
  return dashboardJson(async () => {
    const { count, items } = await getUnmatchedCharges(sb, session.shopId);
    return {
      count,
      // Shape DTOs explicitly — never leak the raw reader row (mirrors the contract C.1
      // field names; the embedded surface uses the same fields).
      items: items.map((it) => ({
        id: it.id,
        provider: it.provider,
        orderRef: it.orderRef,
        trackingNo: it.trackingNo,
        costCents: it.costCents,
        externalChargeId: it.externalChargeId,
        reason: it.reason,
      })),
    };
  });
}
