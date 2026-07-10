// Unified orders list (Phase 2 Task 2): query-string -> OrdersListParams -> listOrdersUnified ->
// snake_case page, backing the orders screen's toolbar (search/filter/sort/paginate) across both
// native and imported-from-Shopify rows. Read-only: no requireSameOrigin (GET only).
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError } from "~/lib/dashboard/http.server";
import { listOrdersUnified } from "~/lib/order/unified-list.server";
import type { OrdersListParams } from "~/lib/order/unified-list-types";

const FULFILLMENT_STATUSES = new Set(["unfulfilled", "partially_fulfilled", "fulfilled"]);
const SOURCES = new Set(["calderyn", "shopify"]);
const SORTS = new Set(["date", "total", "customer"]);
const DIRS = new Set(["asc", "desc"]);

/** True for a value ISO-parseable by Date.parse — same permissive-ISO acceptance the rest of the
 *  codebase uses for date query params (no stricter regex; Postgres/PostgREST are the real gate). */
function isParseableDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const qp = url.searchParams;

  const params: OrdersListParams = {};

  const search = qp.get("search");
  if (search) params.search = search;

  const paymentStatus = qp.get("payment_status");
  if (paymentStatus) {
    params.paymentStatus = paymentStatus
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const fulfillmentStatus = qp.get("fulfillment_status");
  if (fulfillmentStatus) {
    if (!FULFILLMENT_STATUSES.has(fulfillmentStatus)) {
      return jsonError(422, "invalid_fulfillment_status", "fulfillment_status must be one of unfulfilled, partially_fulfilled, fulfilled.");
    }
    params.fulfillmentStatus = fulfillmentStatus as OrdersListParams["fulfillmentStatus"];
  }

  const source = qp.get("source");
  if (source) {
    if (!SOURCES.has(source)) {
      return jsonError(422, "invalid_source", "source must be one of calderyn, shopify.");
    }
    params.source = source as OrdersListParams["source"];
  }

  const dateFrom = qp.get("date_from");
  if (dateFrom) {
    if (!isParseableDate(dateFrom)) return jsonError(422, "invalid_date", "date_from must be a valid ISO date.");
    params.dateFrom = dateFrom;
  }

  const dateTo = qp.get("date_to");
  if (dateTo) {
    if (!isParseableDate(dateTo)) return jsonError(422, "invalid_date", "date_to must be a valid ISO date.");
    params.dateTo = dateTo;
  }

  const tag = qp.get("tag");
  if (tag) params.tag = tag;

  const archived = qp.get("archived");
  if (archived != null) params.archived = archived === "true" || archived === "1";

  const sort = qp.get("sort");
  if (sort) {
    if (!SORTS.has(sort)) return jsonError(422, "invalid_sort", "sort must be one of date, total, customer.");
    params.sort = sort as OrdersListParams["sort"];
  }

  const dir = qp.get("dir");
  if (dir && DIRS.has(dir)) params.dir = dir as OrdersListParams["dir"];

  const offsetRaw = qp.get("offset");
  if (offsetRaw != null) {
    const n = Number(offsetRaw);
    if (Number.isInteger(n) && n >= 0) params.offset = n;
  }

  const limitRaw = qp.get("limit");
  if (limitRaw != null) {
    const n = Number(limitRaw);
    if (Number.isFinite(n)) params.limit = Math.min(Math.max(Math.trunc(n), 1), 100);
  }

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
