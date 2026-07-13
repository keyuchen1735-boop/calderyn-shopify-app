import { useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Btn } from "../ui";
import { CDIcon } from "../icons";
import { reduced } from "../hero/hero-motion";
import type { OrderViewVM, OrdersListParams } from "~/lib/dashboard/orders-client";
import {
  SYSTEM_VIEWS,
  localDayEndIso,
  localDayStartIso,
  pinnedDimension,
  type ListFilterPatch,
} from "./orders-list-state";

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
  const [filtersOpen, setFiltersOpen] = useState(false);

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

  const filterPanelRef = useRef<HTMLDivElement>(null);
  const filterPanelWasOpen = useRef(false);
  useGSAP(
    () => {
      const el = filterPanelRef.current;
      if (!el) return;
      const inner = el.firstElementChild as HTMLElement | null;
      const was = filterPanelWasOpen.current;
      filterPanelWasOpen.current = filtersOpen;
      if (reduced()) {
        el.style.height = filtersOpen ? "auto" : "0px";
        el.style.opacity = filtersOpen ? "1" : "0";
        return;
      }
      if (was === filtersOpen) {
        // First paint (or a no-op re-render): land directly on the resting state, no tween.
        el.style.height = filtersOpen ? "auto" : "0px";
        el.style.opacity = filtersOpen ? "1" : "0";
        return;
      }
      const full = inner ? inner.offsetHeight : el.scrollHeight;
      if (filtersOpen) {
        gsap.set(el, { height: 0, opacity: 0 });
        gsap.to(el, {
          height: full,
          opacity: 1,
          duration: 0.22,
          ease: "power2.out",
          onComplete: () => {
            el.style.height = "auto";
          },
        });
      } else {
        gsap.to(el, { height: 0, opacity: 0, duration: 0.16, ease: "power2.in" });
      }
    },
    { dependencies: [filtersOpen] },
  );

  const confirmSave = () => {
    const name = nameInput.trim();
    if (!name) return;
    onSaveView(name);
    setNameInput("");
    setSavingName(false);
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="cd-orders-toolbar-row">
        <div className="flex items-center gap-2" style={{ flex: "1 1 auto", minWidth: 0, flexWrap: "wrap" }}>
          <div className="cd-orders-search">
            <CDIcon name="search" size={14} strokeWidth={1.8} />
            <input
              type="text"
              placeholder="Search orders"
              aria-label="Search orders"
              value={searchInput}
              onChange={(e) => onSearchInputChange(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="cd-btn cd-btn-secondary cd-btn-sm cd-orders-filter-toggle"
            aria-expanded={filtersOpen}
            aria-controls="orders-filter-panel"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <CDIcon name="sliders" size={14} strokeWidth={1.9} />
            Filters
            {activeFilterCount > 0 && <span className="cd-orders-filter-count">{activeFilterCount}</span>}
          </button>
        </div>

        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <select
            className="cd-input cd-orders-sort"
            aria-label="Sort by"
            value={sort ?? "date"}
            onChange={(e) => onSortChange(e.target.value as OrdersListParams["sort"])}
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
      </div>

      <div
        id="orders-filter-panel"
        ref={filterPanelRef}
        className="cd-orders-filter-panel"
        role="region"
        aria-label="Order filters"
      >
        <div className="flex items-center gap-2.5" style={{ flexWrap: "wrap", paddingTop: 10 }}>
          <select
            className="cd-input"
            aria-label="Payment status"
            disabled={pinned === "paymentStatus"}
            title={pinned === "paymentStatus" ? "Set by the current view tab" : undefined}
            value={pinned === "paymentStatus" ? "unpaid" : (paymentStatus?.[0] ?? "")}
            onChange={(e) => onFilterChange({ paymentStatus: e.target.value ? [e.target.value] : undefined })}
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
            value={pinned === "fulfillmentStatus" ? "unfulfilled" : (fulfillmentStatus ?? "")}
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
              onChange={(e) => onFilterChange({ dateFrom: e.target.value ? localDayStartIso(e.target.value) : undefined })}
              style={{ width: "auto" }}
            />
            <span className="cd-caption">to</span>
            <input
              className="cd-input"
              type="date"
              aria-label="Date to"
              value={isoToDateInputValue(dateTo)}
              onChange={(e) => onFilterChange({ dateTo: e.target.value ? localDayEndIso(e.target.value) : undefined })}
              style={{ width: "auto" }}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2" style={{ marginTop: 10, flexWrap: "wrap" }}>
        <div className="cd-seg cd-seg-sm" role="tablist" aria-label="Order views">
          {SYSTEM_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
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
              className="cd-seg-btn cd-orders-saved-view"
              data-active={view === v.id ? "1" : "0"}
              role="tab"
              aria-selected={view === v.id}
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
                className="cd-orders-saved-view-x"
              >
                <CDIcon name="x" size={11} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>

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
