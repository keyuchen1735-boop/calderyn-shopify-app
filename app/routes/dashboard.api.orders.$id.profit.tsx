// app/routes/dashboard.api.orders.$id.profit.tsx
// Per-order profit read model (Phase 4 Task 3): GET-only, serves both native and imported
// (Shopify-paid, read-only) orders through orderProfit's single OrderProfit contract — this route
// never branches on source, that's the read model's job. Mirrors dashboard.api.orders.$id.tsx's
// not-found contract (null -> 404) exactly.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError } from "~/lib/dashboard/http.server";
import { orderProfit } from "~/lib/order/profit.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    const profit = await orderProfit(session.shopId, id);
    if (!profit) throw jsonError(404, "order_not_found");
    return {
      profit: {
        source: profit.source,
        revenue_cents: profit.revenueCents,
        cogs_cents: profit.cogsCents,
        costs_missing: profit.costsMissing,
        carrier_cost_cents: profit.carrierCostCents,
        fee_estimate_cents: profit.feeEstimateCents,
        profit_cents: profit.profitCents,
        margin_pct: profit.marginPct,
        estimated: profit.estimated,
        attribution_label: profit.attributionLabel,
      },
    };
  });
}
