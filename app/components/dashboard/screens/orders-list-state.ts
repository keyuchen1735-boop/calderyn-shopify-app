// Pure orders-list state helpers (Phase 2 Task 6): system-tab -> fixed filter params, and the
// two-way mapping between a saved view's stored snake_case `filters` blob (order_view.filters,
// validated server-side by VIEW_FILTER_KEYS in view-filters.ts) and OrdersListParams' camelCase
// wire shape. Kept framework-free so both directions are trivially unit-testable, same pattern as
// order-status.ts.
import type { OrdersListParams } from "~/lib/dashboard/orders-client";

export type SystemView = "all" | "unfulfilled" | "unpaid" | "archived";

/** The orders screen's toolbar state: view (a system tab id, or a saved view's uuid), the
 *  effective (debounced) search text, sort/dir (undefined = server default), and the current
 *  page's offset. Every field change except explicit paging resets offset to 0 (see Orders.tsx). */
export interface ListState {
  view: string;
  search: string;
  sort: OrdersListParams["sort"];
  dir: OrdersListParams["dir"];
  offset: number;
}

export const SYSTEM_VIEWS: { id: SystemView; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unfulfilled", label: "Unfulfilled" },
  { id: "unpaid", label: "Unpaid" },
  { id: "archived", label: "Archived" },
];

const SYSTEM_VIEW_IDS = new Set<string>(SYSTEM_VIEWS.map((v) => v.id));

export function isSystemView(view: string): view is SystemView {
  return SYSTEM_VIEW_IDS.has(view);
}

/** Fixed filter params for a system tab. "all" carries none. */
export function systemViewParams(view: SystemView): Partial<OrdersListParams> {
  if (view === "unfulfilled") return { fulfillmentStatus: "unfulfilled" };
  if (view === "unpaid") return { paymentStatus: ["pending", "authorized", "partially_paid"] };
  if (view === "archived") return { archived: true };
  return {};
}

/**
 * A saved view's stored snake_case `filters` blob -> OrdersListParams. Unknown keys (a stale or
 * renamed field) are silently ignored rather than thrown on, matching the server's own
 * forward-compat stance in list-params.server.ts — an old saved view should degrade gracefully,
 * not break the screen.
 */
export function viewFiltersToParams(filters: Record<string, unknown>): Partial<OrdersListParams> {
  const params: Partial<OrdersListParams> = {};
  if (typeof filters.search === "string" && filters.search) params.search = filters.search;
  if (Array.isArray(filters.payment_status)) {
    const values = filters.payment_status.filter((v): v is string => typeof v === "string");
    if (values.length) params.paymentStatus = values;
  }
  if (typeof filters.fulfillment_status === "string" && filters.fulfillment_status) {
    params.fulfillmentStatus = filters.fulfillment_status as OrdersListParams["fulfillmentStatus"];
  }
  if (typeof filters.source === "string" && filters.source) {
    params.source = filters.source as OrdersListParams["source"];
  }
  if (typeof filters.date_from === "string" && filters.date_from) params.dateFrom = filters.date_from;
  if (typeof filters.date_to === "string" && filters.date_to) params.dateTo = filters.date_to;
  if (typeof filters.tag === "string" && filters.tag) params.tag = filters.tag;
  if (typeof filters.archived === "boolean") params.archived = filters.archived;
  if (typeof filters.sort === "string" && filters.sort) params.sort = filters.sort as OrdersListParams["sort"];
  if (typeof filters.dir === "string" && filters.dir) params.dir = filters.dir as OrdersListParams["dir"];
  return params;
}

/**
 * Inverse of viewFiltersToParams: the currently-resolved filters (whatever a system tab or an
 * already-applied saved view contributed, plus the toolbar's live search/sort/dir) -> the
 * snake_case blob createOrderView persists. offset/limit deliberately never round-trip — a saved
 * view is a filter preset, not a bookmark of a page position.
 */
export function paramsToViewFilters(params: Partial<OrdersListParams>): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (params.search) filters.search = params.search;
  if (params.paymentStatus?.length) filters.payment_status = params.paymentStatus;
  if (params.fulfillmentStatus) filters.fulfillment_status = params.fulfillmentStatus;
  if (params.source) filters.source = params.source;
  if (params.dateFrom) filters.date_from = params.dateFrom;
  if (params.dateTo) filters.date_to = params.dateTo;
  if (params.tag) filters.tag = params.tag;
  if (params.archived !== undefined) filters.archived = params.archived;
  if (params.sort) filters.sort = params.sort;
  if (params.dir) filters.dir = params.dir;
  return filters;
}
