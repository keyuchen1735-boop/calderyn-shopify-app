// Unified orders list (Phase 2 Task 2): query-string -> OrdersListParams -> listOrdersUnified ->
// snake_case page, backing the orders screen's toolbar (search/filter/sort/paginate) across both
// native and imported-from-Shopify rows. Read-only: no requireSameOrigin (GET only).
// Param parsing lives in list-params.server.ts (Phase 2 Task 4), shared with the CSV export route
// so both accept an identical filter surface.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { parseOrdersListParams } from "~/lib/order/list-params.server";
import { listOrdersUnified } from "~/lib/order/unified-list.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const params = parseOrdersListParams(url);
  if (params instanceof Response) return params;

  return dashboardJson(async () => {
    const page = await listOrdersUnified(session.shopId, params);
    return {
      rows: page.rows.map((row) => ({
        source: row.source,
        id: row.id,
        ref: row.ref,
        buyer_email: row.buyerEmail,
        total_cents: row.totalCents,
        currency: row.currency,
        payment_status: row.paymentStatus,
        state: row.state,
        cancelled_at: row.cancelledAt,
        archived_at: row.archivedAt,
        occurred_at: row.occurredAt,
        item_count: row.itemCount,
        tags: row.tags,
        remaining_refundable_cents: row.remainingRefundableCents,
      })),
      total_count: page.totalCount,
      offset: page.offset,
      limit: page.limit,
    };
  });
}
