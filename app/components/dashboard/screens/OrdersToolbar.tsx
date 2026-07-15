import { useState } from "react";
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

const SORT_OPTIONS: {
  value: NonNullable<OrdersListParams["sort"]>;
  label: string;
}[] = [
  { value: "date", label: "Date" },
  { value: "total", label: "Total" },
  { value: "customer", label: "Customer" },
];

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

/** Orders screen toolbar (Phase 2 Task 6, compacted in the polish pass): a single search+filters+
 *  sort row, a collapsible filter panel (system tabs + saved views live below it), and the view-tab
 *  row. A pure display/controlled component — Orders.tsx owns every bit of state and passes it
 *  down, so this file never touches the network or the screen cache. */
export default function OrdersToolbar({
  view,
  savedViews,
  onViewChange,
  onDeleteView,
  searchInput,
  onSearchInputChange,
  sort,
  dir,
  onSortChange,
  onDirChange,
  canSaveView,
  onSaveView,
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
  sort: OrdersListParams["sort"];
  dir: OrdersListParams["dir"];
  onSortChange: (sort: OrdersListParams["sort"]) => void;
  onDirChange: (dir: OrdersListParams["dir"]) => void;
  canSaveView: boolean;
  onSaveView: (name: string) => void;
  exportHref: string;
  paymentStatus?: string[];
  fulfillmentStatus?: OrdersListParams["fulfillmentStatus"];
  source?: OrdersListParams["source"];
  dateFrom?: string;
  dateTo?: string;
  onFilterChange: (patch: ListFilterPatch) => void;
}) {
  const [savingName, setSavingName] = useState(false);
  const [nameInput, setNameInput] = useState("");

  // A system tab that pins a filter dimension (Unfulfilled -> fulfillmentStatus, Unpaid ->
  // paymentStatus) already wins that dimension in stateToParams regardless of what's picked here —
  // so the matching select is disabled and forced to show the tab's own value, rather than letting
  // the merchant pick a value the query silently ignores.
  const pinned = pinnedDimension(view);

  // How many manual filter controls carry a value right now — shown as a count badge on the
  // collapsed Filters toggle so an active filter is never invisible just because the panel is
  // closed. A date range counts once (from/to together are one "when" filter, not two).
  const activeFilterCount =
    (paymentStatus?.length ? 1 : 0) +
    (fulfillmentStatus ? 1 : 0) +
    (source ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0);

  const confirmSave = () => {
    const name = nameInput.trim();
    if (!name) return;
    onSaveView(name);
    setNameInput("");
    setSavingName(false);
  };

  const listViews: OrderListView[] = [
    ...SYSTEM_VIEWS,
    ...savedViews.map((saved) => ({
      id: saved.id,
      label: saved.name,
    })),
  ];
  const activeSavedView = savedViews.find((saved) => saved.id === view);

  const viewExtras = (
    <>
      {activeSavedView && (
        <Btn small onClick={() => onDeleteView(activeSavedView.id)}>
          Delete view
        </Btn>
      )}
      {canSaveView && !savingName && (
        <Btn small icon="plus" onClick={() => setSavingName(true)}>
          Save view
        </Btn>
      )}
      {savingName && (
        <div className="cd-orders-save-view">
          <input
            className="cd-input"
            autoFocus
            placeholder="View name"
            aria-label="New view name"
            value={nameInput}
            onChange={(event) => setNameInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") confirmSave();
              if (event.key === "Escape") {
                setSavingName(false);
                setNameInput("");
              }
            }}
          />
          <Btn
            small
            kind="primary"
            onClick={confirmSave}
            disabled={!nameInput.trim()}
          >
            Save
          </Btn>
          <Btn
            small
            onClick={() => {
              setSavingName(false);
              setNameInput("");
            }}
          >
            Cancel
          </Btn>
        </div>
      )}
    </>
  );

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
      sortOptions={SORT_OPTIONS}
      sort={sort ?? "date"}
      dir={dir ?? "desc"}
      onSortChange={(next) => onSortChange(next as OrdersListParams["sort"])}
      onDirChange={onDirChange}
      activeFilterCount={activeFilterCount}
      filterLabel="Order"
      onExport={() => window.open(exportHref, "_blank")}
      filterChildren={
        <div className="cd-orders-filter-fields">
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
              pinned === "paymentStatus" ? "unpaid" : (paymentStatus?.[0] ?? "")
            }
            onChange={(e) =>
              onFilterChange({
                paymentStatus: e.target.value ? [e.target.value] : undefined,
              })
            }
            style={{ width: "auto" }}
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
            style={{ width: "auto" }}
          >
            {FULFILLMENT_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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
            style={{ width: "auto" }}
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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
              style={{ width: "auto" }}
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
              style={{ width: "auto" }}
            />
          </div>
        </div>
      }
    />
  );
}
