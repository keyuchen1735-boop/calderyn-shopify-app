import { useState } from "react";
import { Btn } from "../ui";
import { CDIcon } from "../icons";
import type { OrderViewVM, OrdersListParams } from "~/lib/dashboard/orders-client";
import { SYSTEM_VIEWS, type ListFilterPatch } from "./orders-list-state";

const SORT_OPTIONS: { value: NonNullable<OrdersListParams["sort"]>; label: string }[] = [
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

const FULFILLMENT_STATUS_OPTIONS: { value: NonNullable<OrdersListParams["fulfillmentStatus"]> | ""; label: string }[] = [
  { value: "", label: "Any" },
  { value: "unfulfilled", label: "Unfulfilled" },
  { value: "partially_fulfilled", label: "Partially fulfilled" },
  { value: "fulfilled", label: "Fulfilled" },
];

const SOURCE_OPTIONS: { value: NonNullable<OrdersListParams["source"]> | ""; label: string }[] = [
  { value: "", label: "All sources" },
  { value: "calderyn", label: "Calderyn" },
  { value: "shopify", label: "Shopify" },
];

/** `dateTo` end-of-day ISO for a same-day range to actually match: an <input type="date"> only
 *  ever gives a bare "YYYY-MM-DD", which as a start-of-day ISO would exclude every order placed
 *  later that same day. Stamping 23:59:59.999Z makes "from today to today" cover the whole day. */
function dateToEndOfDayIso(raw: string): string | undefined {
  return raw ? `${raw}T23:59:59.999Z` : undefined;
}

/** ISO datetime -> the bare "YYYY-MM-DD" an <input type="date"> can display. */
function isoToDateInputValue(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

/** Orders screen toolbar (Phase 2 Task 6): search, sort, Export CSV, and the view-tab row
 *  (system tabs + saved views). A pure display/controlled component — Orders.tsx owns every bit
 *  of state and passes it down, so this file never touches the network or the screen cache. */
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

  const confirmSave = () => {
    const name = nameInput.trim();
    if (!name) return;
    onSaveView(name);
    setNameInput("");
    setSavingName(false);
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="flex items-center gap-2.5" style={{ flexWrap: "wrap" }}>
        <input
          className="cd-input"
          placeholder="Search orders"
          aria-label="Search orders"
          value={searchInput}
          onChange={(e) => onSearchInputChange(e.target.value)}
          style={{ width: "auto", minWidth: 220, flex: "1 1 220px" }}
        />
        <select
          className="cd-input"
          aria-label="Sort by"
          value={sort ?? "date"}
          onChange={(e) => onSortChange(e.target.value as OrdersListParams["sort"])}
          style={{ width: "auto" }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Btn
          small
          icon={dir === "asc" ? "arrowUp" : "arrowDown"}
          onClick={() => onDirChange(dir === "asc" ? "desc" : "asc")}
        >
          {dir === "asc" ? "Asc" : "Desc"}
        </Btn>
        <Btn small icon="download" onClick={() => window.open(exportHref, "_blank")}>
          Export CSV
        </Btn>
      </div>

      <div className="flex items-center gap-2.5" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <select
          className="cd-input"
          aria-label="Payment status"
          value={paymentStatus?.[0] ?? ""}
          onChange={(e) => onFilterChange({ paymentStatus: e.target.value ? [e.target.value] : undefined })}
          style={{ width: "auto" }}
        >
          {PAYMENT_STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="cd-input"
          aria-label="Fulfillment status"
          title="Shopify-imported orders are excluded when this filter is set"
          value={fulfillmentStatus ?? ""}
          onChange={(e) =>
            onFilterChange({
              fulfillmentStatus: (e.target.value || undefined) as OrdersListParams["fulfillmentStatus"],
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
            onFilterChange({ source: (e.target.value || undefined) as OrdersListParams["source"] })
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
            onChange={(e) => onFilterChange({ dateFrom: e.target.value || undefined })}
            style={{ width: "auto" }}
          />
          <span className="cd-caption">to</span>
          <input
            className="cd-input"
            type="date"
            aria-label="Date to"
            value={isoToDateInputValue(dateTo)}
            onChange={(e) => onFilterChange({ dateTo: dateToEndOfDayIso(e.target.value) })}
            style={{ width: "auto" }}
          />
        </div>
      </div>

      <div className="flex items-center gap-2" style={{ marginTop: 10, flexWrap: "wrap" }}>
        {SYSTEM_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className="cd-seg-btn"
            data-active={view === v.id ? "1" : "0"}
            onClick={() => onViewChange(v.id)}
          >
            {v.label}
          </button>
        ))}
        {savedViews.map((v) => (
          <span
            key={v.id}
            className="cd-seg-btn"
            data-active={view === v.id ? "1" : "0"}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onClick={() => onViewChange(v.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onViewChange(v.id);
            }}
          >
            {v.name}
            <button
              type="button"
              aria-label={`Delete view ${v.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteView(v.id);
              }}
              style={{
                display: "inline-flex",
                background: "none",
                border: 0,
                padding: 0,
                cursor: "pointer",
                color: "inherit",
                opacity: 0.6,
              }}
            >
              <CDIcon name="x" size={11} strokeWidth={2} />
            </button>
          </span>
        ))}

        {canSaveView && !savingName && (
          <Btn small icon="plus" onClick={() => setSavingName(true)}>
            Save view
          </Btn>
        )}
        {savingName && (
          <div className="flex items-center gap-2">
            <input
              className="cd-input"
              autoFocus
              placeholder="View name"
              aria-label="New view name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSave();
                if (e.key === "Escape") {
                  setSavingName(false);
                  setNameInput("");
                }
              }}
              style={{ width: 160 }}
            />
            <Btn small kind="primary" onClick={confirmSave} disabled={!nameInput.trim()}>
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
      </div>
    </div>
  );
}
