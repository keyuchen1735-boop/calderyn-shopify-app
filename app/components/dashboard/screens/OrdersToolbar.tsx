import { Btn } from "../ui";
import type {
  OrderViewVM,
  OrdersListParams,
} from "~/lib/dashboard/orders-client";
import {
  SYSTEM_VIEWS,
  localDayEndIso,
  localDayStartIso,
  pinnedDimension,
  type ListFilterPatch,
} from "./orders-list-state";
import { OrderListToolbar, type OrderListView } from "./OrderListFamily";

// Single-select payment-status options — the underlying filter is a string[] (a saved view or a
// future multi-select could carry more than one), but the toolbar only ever picks one at a time.
const PAYMENT_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Any" },
  { value: "paid", label: "Paid" },
  { value: "pending", label: "Pending" },
  { value: "authorized", label: "Authorized" },
  { value: "partially_paid", label: "Partially paid" },
  { value: "partially_refunded", label: "Partially refunded" },
  { value: "refunded", label: "Refunded" },
];

const FULFILLMENT_STATUS_OPTIONS: {
  value: NonNullable<OrdersListParams["fulfillmentStatus"]> | "";
  label: string;
}[] = [
  { value: "", label: "Any" },
  { value: "unfulfilled", label: "Unfulfilled" },
  { value: "partially_fulfilled", label: "Partially fulfilled" },
  { value: "fulfilled", label: "Fulfilled" },
];

const SOURCE_OPTIONS: {
  value: NonNullable<OrdersListParams["source"]> | "";
  label: string;
}[] = [
  { value: "", label: "All sources" },
  { value: "calderyn", label: "Calderyn" },
  { value: "shopify", label: "Shopify" },
];

/** ISO datetime -> the bare "YYYY-MM-DD" an <input type="date"> can display. */
function isoToDateInputValue(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

/** Orders screen toolbar: one row of view tabs + search + a Filters popover, with Export on the
 *  right (see OrderListToolbar). Column sorting lives on the table headers (Orders.tsx), not here.
 *  A pure display/controlled component — Orders.tsx owns every bit of state and passes it down, so
 *  this file never touches the network or the screen cache. */
export default function OrdersToolbar({
  view,
  savedViews,
  onViewChange,
  onDeleteView,
  searchInput,
  onSearchInputChange,
  exportHref,
  paymentStatus,
  fulfillmentStatus,
  source,
  dateFrom,
  dateTo,
  onFilterChange,
}: {
  view: string;
  savedViews: OrderViewVM[];
  onViewChange: (view: string) => void;
  onDeleteView: (id: string) => void;
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  exportHref: string;
  paymentStatus?: string[];
  fulfillmentStatus?: OrdersListParams["fulfillmentStatus"];
  source?: OrdersListParams["source"];
  dateFrom?: string;
  dateTo?: string;
  onFilterChange: (patch: ListFilterPatch) => void;
}) {
  // A system tab that pins a filter dimension (Unfulfilled -> fulfillmentStatus, Unpaid ->
  // paymentStatus) already wins that dimension in stateToParams regardless of what's picked here —
  // so the matching select is disabled and forced to show the tab's own value, rather than letting
  // the merchant pick a value the query silently ignores.
  const pinned = pinnedDimension(view);

  // How many manual filter controls carry a value right now — shown as a count badge on the
  // Filters toggle so an active filter is never invisible while the popover is closed. A date
  // range counts once (from/to together are one "when" filter, not two).
  const activeFilterCount =
    (paymentStatus?.length ? 1 : 0) +
    (fulfillmentStatus ? 1 : 0) +
    (source ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0);

  const listViews: OrderListView[] = [
    ...SYSTEM_VIEWS,
    ...savedViews.map((saved) => ({
      id: saved.id,
      label: saved.name,
    })),
  ];
  const activeSavedView = savedViews.find((saved) => saved.id === view);

  const viewExtras = activeSavedView ? (
    <Btn small onClick={() => onDeleteView(activeSavedView.id)}>
      Delete view
    </Btn>
  ) : undefined;

  return (
    <OrderListToolbar
      views={listViews}
      view={view}
      onViewChange={onViewChange}
      viewExtras={viewExtras}
      searchValue={searchInput}
      searchPlaceholder="Search orders"
      searchAriaLabel="Search orders"
      onSearchChange={onSearchInputChange}
      activeFilterCount={activeFilterCount}
      filterLabel="Order"
      onExport={() => window.open(exportHref, "_blank")}
      filterChildren={
        <div className="cd-orders-filter-fields">
          <label>
            <span className="cd-caption">Payment</span>
            <select
              className="cd-input"
              aria-label="Payment status"
              disabled={pinned === "paymentStatus"}
              title={
                pinned === "paymentStatus"
                  ? "Set by the current view tab"
                  : undefined
              }
              value={
                pinned === "paymentStatus"
                  ? "unpaid"
                  : (paymentStatus?.[0] ?? "")
              }
              onChange={(e) =>
                onFilterChange({
                  paymentStatus: e.target.value ? [e.target.value] : undefined,
                })
              }
            >
              {pinned === "paymentStatus" ? (
                <option value="unpaid">Unpaid statuses</option>
              ) : (
                PAYMENT_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))
              )}
            </select>
          </label>
          <label>
            <span className="cd-caption">Fulfillment</span>
            <select
              className="cd-input"
              aria-label="Fulfillment status"
              disabled={pinned === "fulfillmentStatus"}
              title={
                pinned === "fulfillmentStatus"
                  ? "Set by the current view tab"
                  : "Shopify-imported orders are excluded when this filter is set"
              }
              value={
                pinned === "fulfillmentStatus"
                  ? "unfulfilled"
                  : (fulfillmentStatus ?? "")
              }
              onChange={(e) =>
                onFilterChange({
                  fulfillmentStatus: (e.target.value ||
                    undefined) as OrdersListParams["fulfillmentStatus"],
                })
              }
            >
              {FULFILLMENT_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="cd-caption">Source</span>
            <select
              className="cd-input"
              aria-label="Order source"
              value={source ?? ""}
              onChange={(e) =>
                onFilterChange({
                  source: (e.target.value ||
                    undefined) as OrdersListParams["source"],
                })
              }
            >
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="cd-orders-filter-daterange">
            <span className="cd-caption">Date range</span>
            <div className="flex items-center gap-1.5">
              <input
                className="cd-input"
                type="date"
                aria-label="Date from"
                value={isoToDateInputValue(dateFrom)}
                onChange={(e) =>
                  onFilterChange({
                    dateFrom: e.target.value
                      ? localDayStartIso(e.target.value)
                      : undefined,
                  })
                }
              />
              <span className="cd-caption">to</span>
              <input
                className="cd-input"
                type="date"
                aria-label="Date to"
                value={isoToDateInputValue(dateTo)}
                onChange={(e) =>
                  onFilterChange({
                    dateTo: e.target.value
                      ? localDayEndIso(e.target.value)
                      : undefined,
                  })
                }
              />
            </div>
          </div>
        </div>
      }
    />
  );
}
