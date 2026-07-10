// Shared query-string -> OrdersListParams parser (Phase 2 Task 4). Extracted from
// dashboard.api.orders.list.tsx so the CSV export route accepts the identical filter surface
// without duplicating ~50 lines of validation. Both routes must stay behaviorally identical —
// change validation here, not in either route.
import { jsonError } from "~/lib/dashboard/http.server";
import type { OrdersListParams } from "./unified-list-types";

const FULFILLMENT_STATUSES = new Set(["unfulfilled", "partially_fulfilled", "fulfilled"]);
const SOURCES = new Set(["calderyn", "shopify"]);
const SORTS = new Set(["date", "total", "customer"]);
const DIRS = new Set(["asc", "desc"]);

/** True for a value ISO-parseable by Date.parse — same permissive-ISO acceptance the rest of the
 *  codebase uses for date query params (no stricter regex; Postgres/PostgREST are the real gate). */
function isParseableDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Parse the orders list/export query string into OrdersListParams, or a 422 jsonError Response
 * on the first invalid field (caller returns it as-is). Shared by dashboard.api.orders.list.tsx
 * and dashboard.api.orders.export.tsx.
 */
export function parseOrdersListParams(url: URL): OrdersListParams | Response {
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

  return params;
}
