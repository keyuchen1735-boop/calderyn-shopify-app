// Pure orders-list state helpers (Phase 2 Task 6): system-tab -> fixed filter params, and the
// two-way mapping between a saved view's stored snake_case `filters` blob (order_view.filters,
// validated server-side by VIEW_FILTER_KEYS in view-filters.ts) and OrdersListParams' camelCase
// wire shape. Kept framework-free so both directions are trivially unit-testable, same pattern as
// order-status.ts.
import type { OrderViewVM, OrdersListParams } from "~/lib/dashboard/orders-client";

export type SystemView = "all" | "unfulfilled" | "unpaid" | "archived";

/** The orders screen's toolbar state: view (a system tab id, or a saved view's uuid), the
 *  effective (debounced) search text, the manually-picked toolbar filters (payment/fulfillment
 *  status, source, date range), sort/dir (undefined = server default), and the current page's
 *  offset. Every field change except explicit paging resets offset to 0 (see Orders.tsx). The
 *  manual filters are separate from a system tab's own fixed filter (systemViewParams) — see
 *  stateToParams for how the two combine. */
export interface ListState {
  view: string;
  search: string;
  paymentStatus?: string[];
  fulfillmentStatus?: OrdersListParams["fulfillmentStatus"];
  source?: OrdersListParams["source"];
  dateFrom?: string;
  dateTo?: string;
  sort: OrdersListParams["sort"];
  dir: OrdersListParams["dir"];
  offset: number;
}

/** The toolbar-filter subset of ListState a filter control writes to — everything except the
 *  view/search/sort/dir/offset fields, which each have their own dedicated handler. */
export type ListFilterPatch = Partial<
  Pick<ListState, "paymentStatus" | "fulfillmentStatus" | "source" | "dateFrom" | "dateTo">
>;

/** Bare "YYYY-MM-DD" (an <input type="date">'s only possible value) -> local midnight ISO, i.e.
 *  the start of that calendar day in the browser's own timezone. Constructing with
 *  `new Date(y, m - 1, d)` (the local-time constructor) rather than `new Date(raw)` (which parses
 *  a bare date as UTC midnight) is what anchors day boundaries to the merchant's browser timezone
 *  instead of UTC — the previous UTC anchoring cut "today" off hours early for merchants west of
 *  UTC. */
export function localDayStartIso(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
}

/** Bare "YYYY-MM-DD" -> local end-of-day ISO (23:59:59.999 in the browser's own timezone), so a
 *  "from today to today" range covers the whole local day rather than ending at UTC midnight. */
export function localDayEndIso(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
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

/** Which toolbar filter control (if any) a system tab pins to a fixed value. stateToParams already
 *  lets that tab's own fixed filter win over a manual control on the same dimension — so without
 *  this, the control still looks editable while having zero effect on the query. The toolbar uses
 *  this to disable and force the value of that one control; "archived" has no matching select. */
export function pinnedDimension(view: string): "fulfillmentStatus" | "paymentStatus" | null {
  if (view === "unfulfilled") return "fulfillmentStatus";
  if (view === "unpaid") return "paymentStatus";
  return null;
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

/** The system tab's fixed filters, or a saved view's stored filters decoded back to
 *  OrdersListParams. Unknown/removed saved-view id resolves to no extra filters (same as "all"). */
export function resolveViewFilters(view: string, savedViews: OrderViewVM[]): Partial<OrdersListParams> {
  if (isSystemView(view)) return systemViewParams(view);
  const saved = savedViews.find((v) => v.id === view);
  return saved ? viewFiltersToParams(saved.filters) : {};
}

/**
 * ListState -> OrdersListParams. Two different merge rules, in one function so they can never
 * drift apart:
 *  - The manually-picked toolbar filters (payment/fulfillment status, source, date range) are
 *    spread FIRST, then the resolved view's fixed filters spread ON TOP — so a system tab's own
 *    filter dimension (e.g. Unfulfilled's fulfillmentStatus, Unpaid's paymentStatus, Archived's
 *    archived) always wins over a manual control on that same dimension, while every other manual
 *    filter passes through untouched (viewFilters is a Partial, so a key it never sets can't
 *    clobber the manual one). A saved view carries the same shape, so it merges identically.
 *  - search/sort/dir/offset are the toolbar's own long-standing controls, independent of which
 *    view is active: the live state value always wins, same as before this fix, even though a
 *    saved view's stored filters blob can technically carry its own sort/dir/search.
 */
export function stateToParams(state: ListState, savedViews: OrderViewVM[]): OrdersListParams {
  const viewFilters = resolveViewFilters(state.view, savedViews);
  return {
    paymentStatus: state.paymentStatus,
    fulfillmentStatus: state.fulfillmentStatus,
    source: state.source,
    dateFrom: state.dateFrom,
    dateTo: state.dateTo,
    ...viewFilters,
    search: state.search || undefined,
    sort: state.sort,
    dir: state.dir,
    offset: state.offset,
  };
}
