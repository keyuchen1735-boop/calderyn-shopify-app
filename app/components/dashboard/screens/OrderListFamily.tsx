import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import { CDIcon } from "../icons";
import { Btn, Pan, Placeholder, TableSkeleton } from "../ui";
import { reduced } from "../hero/hero-motion";

export interface OrderListView {
  id: string;
  label: string;
}

/** Sort keys whose first click reads most naturally ascending (text columns, A-Z); every other
 *  key (dates, money) starts at newest/biggest first. Shared by every screen that renders
 *  OrderSortHeader so the same-named column never sorts in opposite first directions. */
const ASC_FIRST_SORT_COLS = new Set([
  "customer",
  "order",
  "title",
  "name",
  "location",
  "segment",
  "product",
]);

/** State transition for a column-header click, shared by the unified list and the sub-lists so
 *  the policy can't drift: a new column sorts by its natural first direction; the active column
 *  flips; a third click (both directions seen) returns to the list's default ordering. That last
 *  step is what keeps the default reachable even when it has no column of its own (the labels
 *  list defaults to a date sort but shows no date column). */
export function nextSortState(
  current: { sort: string; dir: "asc" | "desc" },
  col: string,
  defaults: { sort: string; dir: "asc" | "desc" },
): { sort: string; dir: "asc" | "desc" } {
  const naturalDir: "asc" | "desc" = ASC_FIRST_SORT_COLS.has(col) ? "asc" : "desc";
  if (current.sort !== col) return { sort: col, dir: naturalDir };
  if (current.dir === naturalDir) {
    return { sort: col, dir: naturalDir === "asc" ? "desc" : "asc" };
  }
  return defaults;
}

/** Which row the entrance should start animating from, given the previously
 *  animated signature and the new one.
 *
 *  A "load more" page appends to the rows already on screen. Replaying the
 *  entrance across the whole list would re-animate everything the merchant is
 *  already reading, and since the stagger grows with the list, page 3 of a long
 *  catalog would ripple for seconds. An append extends the previous signature,
 *  which is how it is told apart from a re-sort (same rows, new order) or a
 *  filter change (different rows): on an append only the new tail rises, and
 *  everything else animates in full.
 *
 *  Pure and exported for tests — the alternative is asserting on GSAP targets. */
export function entranceStartIndex(previous: string | null, signature: string): number {
  if (previous === null || previous === "") return 0;
  if (!signature.startsWith(`${previous}|`)) return 0;
  return previous.split("|").length;
}

/**
 * Staggered row rise for a list table, replayed on loads, filter switches and
 * re-sorts. Shared so every sortable list gets the same entrance and the same
 * two hardening rules, which are easy to get subtly wrong per-screen:
 *
 * - `revertOnUpdate` plus explicit from/to values, so back-to-back sort clicks
 *   stay clean. A `from()` started mid-tween would capture the half-faded state
 *   as its target and leave rows stuck dim.
 * - a row-signature guard, so a replay only happens when the rows actually
 *   moved. Without it the mount revalidation that merely confirms the cached
 *   page, or a sort flip where every visible value ties, would flash the list
 *   for no reason.
 *
 * `signature` should identify the visible rows in order (typically their ids
 * joined). `deps` are the state changes allowed to trigger a replay — pass the
 * data, the view filter and the sort state, but deliberately not the search
 * text: replaying the entrance on every keystroke makes the list flicker while
 * typing.
 */
export function useSortedRowsEntrance(
  ref: RefObject<HTMLElement>,
  signature: string,
  deps: unknown[],
) {
  const animatedKey = useRef<string | null>(null);
  useGSAP(
    () => {
      if (!ref.current) {
        // The list DOM went away (a detail view replaced it): forget the last
        // entrance so returning to the list animates again.
        animatedKey.current = null;
        return;
      }
      if (reduced()) return;
      const rows = ref.current.querySelectorAll<HTMLElement>(".cd-trow");
      if (!rows.length) {
        animatedKey.current = null;
        return;
      }
      if (animatedKey.current === signature) return;
      const previous = animatedKey.current;
      animatedKey.current = signature;

      const targets = Array.from(rows).slice(entranceStartIndex(previous, signature));
      if (!targets.length) return;

      gsap.fromTo(
        targets,
        { autoAlpha: 0, y: 6 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.25,
          stagger: 0.02,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform",
        },
      );
    },
    { dependencies: deps, scope: ref, revertOnUpdate: true },
  );
}

function csvCell(value: string | number | null): string {
  let text = value == null ? "" : String(value);
  // Text fields carry customer-controlled values (emails, cities): neutralize spreadsheet
  // formula injection. Numbers are exempt so negative amounts survive untouched.
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Client-side CSV download shared by every list screen's Export action. */
export function downloadCsv(
  filename: string,
  rows: Array<Array<string | number | null>>,
): void {
  const body = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(
    new Blob([body], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Column-header sort control: the header label itself is the button, with an up/down arrow that
 *  reflects the live direction on the active column and sits faint on the others. The accessible
 *  name carries the current sort state (the arrow is icon-only), standing in for the announced
 *  state the old sort dropdown + direction button provided. */
export function OrderSortHeader({
  label,
  col,
  sort,
  dir,
  onSort,
  align,
}: {
  label: string;
  col: string;
  sort: string;
  dir: "asc" | "desc";
  onSort: (col: string) => void;
  align?: "right";
}) {
  const active = sort === col;
  const arrow = active && dir === "asc" ? "arrowUp" : "arrowDown";
  return (
    <span className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        className="cd-orders-sort-hd"
        data-active={active ? "1" : "0"}
        aria-label={
          active
            ? `${label}, sorted ${dir === "asc" ? "ascending" : "descending"}`
            : `Sort by ${label.toLowerCase()}`
        }
        onClick={() => onSort(col)}
      >
        {label}
        <CDIcon name={arrow} size={11} strokeWidth={2.2} />
      </button>
    </span>
  );
}

export interface OrderReadoutItem {
  label: string;
  value: string;
  action?: () => void;
}

/** The stat strip under a list screen's h1 ("1,204 orders · $12k page value · 3 alerts") — shared
 *  so every list page (orders, products, inventory, collections) carries the same header anatomy.
 *  Items stagger-rise whenever their composition changes. */
export function OrderPageReadout({
  items,
  ariaLabel,
}: {
  items: OrderReadoutItem[];
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const key = items.map((item) => `${item.label}:${item.value}`).join("|");
  useGSAP(
    () => {
      if (reduced() || !ref.current) return;
      const els = ref.current.querySelectorAll<HTMLElement>(".cd-order-readout-item");
      gsap.fromTo(
        els,
        { autoAlpha: 0, y: 6, willChange: "transform,opacity" },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.28,
          stagger: 0.045,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform,willChange",
        },
      );
    },
    { dependencies: [key], scope: ref, revertOnUpdate: true },
  );
  if (items.length === 0) {
    // First paint before any data has landed: same-height shimmer ghosts hold the strip's exact
    // space, so the page never pushes down the moment the real numbers arrive.
    return (
      <div ref={ref} className="cd-order-readout" aria-label={ariaLabel} aria-busy="true">
        {[56, 72, 48].map((w, i) => (
          <div key={i} className="cd-order-readout-item cd-order-readout-ghost" aria-hidden="true">
            <span className="cd-skel-bar" style={{ width: 24, height: 11 }} />
            <span className="cd-skel-bar" style={{ width: w, height: 11 }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div ref={ref} className="cd-order-readout" aria-label={ariaLabel}>
      {items.map((item) => {
        const content = (
          <>
            <strong className="tabular-nums">{item.value}</strong>
            <span>{item.label}</span>
            {item.action && <CDIcon name="arrowRight" size={14} strokeWidth={1.9} />}
          </>
        );
        return item.action ? (
          <button
            key={item.label}
            type="button"
            className="cd-order-readout-item"
            data-action="1"
            onClick={item.action}
          >
            {content}
          </button>
        ) : (
          <div key={item.label} className="cd-order-readout-item">
            {content}
          </div>
        );
      })}
    </div>
  );
}

export function OrderListToolbar({
  views,
  view,
  onViewChange,
  viewExtras,
  searchValue,
  searchPlaceholder,
  searchAriaLabel,
  onSearchChange,
  activeFilterCount = 0,
  filterLabel,
  filterChildren,
  exportLabel = "Export",
  onExport,
}: {
  views: OrderListView[];
  view: string;
  onViewChange: (view: string) => void;
  viewExtras?: ReactNode;
  searchValue: string;
  searchPlaceholder: string;
  searchAriaLabel: string;
  onSearchChange: (value: string) => void;
  activeFilterCount?: number;
  filterLabel: string;
  // Omitting filterChildren omits the Filters button entirely; omitting onExport omits Export —
  // lists without extra filters (e.g. the product catalog) share the rest of the toolbar.
  filterChildren?: ReactNode;
  exportLabel?: string;
  onExport?: () => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterToggleRef = useRef<HTMLButtonElement>(null);
  const filterWrapRef = useRef<HTMLDivElement>(null);
  const filterPopRef = useRef<HTMLDivElement>(null);
  const filterPanelId = useId();

  // The filter panel is a floating popover anchored to the Filters button — it overlays the list
  // rather than reflowing the toolbar. Close on any press outside the button+panel pair, or on
  // Escape. Every close path restores focus to the toggle when focus was inside the panel: the
  // popover unmounts on close, so focus left in it would otherwise drop to <body>.
  useEffect(() => {
    if (!filtersOpen) return;
    const onDown = (event: MouseEvent) => {
      if (
        filterWrapRef.current &&
        !filterWrapRef.current.contains(event.target as Node)
      ) {
        if (filterPopRef.current?.contains(document.activeElement)) {
          filterToggleRef.current?.focus();
        }
        setFiltersOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (filterPopRef.current?.contains(document.activeElement)) {
        filterToggleRef.current?.focus();
      }
      setFiltersOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [filtersOpen]);

  useGSAP(
    () => {
      const el = filterPopRef.current;
      if (!el || !filtersOpen || reduced()) return;
      gsap.fromTo(
        el,
        { autoAlpha: 0, y: -6, scale: 0.98 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.18, ease: "power2.out" },
      );
    },
    { dependencies: [filtersOpen], scope: filterPopRef },
  );

  return (
    <div className="cd-orders-toolbar">
      <div className="cd-orders-toolbar-row">
        <div className="cd-orders-toolbar-primary">
          <div
            className="cd-seg cd-seg-sm"
            role="tablist"
            aria-label={`${filterLabel} views`}
          >
            {views.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={view === option.id}
                className="cd-seg-btn"
                data-active={view === option.id ? "1" : "0"}
                onClick={() => onViewChange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="cd-orders-search">
            <CDIcon name="search" size={13} strokeWidth={1.8} />
            <input
              type="text"
              placeholder={searchPlaceholder}
              aria-label={searchAriaLabel}
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
            />
            {searchValue && (
              <button
                type="button"
                className="cd-orders-search-clear"
                aria-label={`Clear ${searchAriaLabel.toLowerCase()}`}
                onClick={() => onSearchChange("")}
              >
                <CDIcon name="x" size={12} strokeWidth={2} />
              </button>
            )}
          </div>

          {filterChildren != null && (
          <div className="cd-orders-filter-wrap" ref={filterWrapRef}>
            <button
              ref={filterToggleRef}
              type="button"
              className="cd-btn cd-btn-secondary cd-btn-sm cd-orders-filter-toggle"
              aria-expanded={filtersOpen}
              aria-controls={filterPanelId}
              onClick={() => {
                if (
                  filtersOpen &&
                  filterPopRef.current?.contains(document.activeElement)
                ) {
                  filterToggleRef.current?.focus();
                }
                setFiltersOpen((open) => !open);
              }}
            >
              <CDIcon name="sliders" size={14} strokeWidth={1.9} />
              Filters
              {activeFilterCount > 0 && (
                <span className="cd-orders-filter-count">
                  {activeFilterCount}
                </span>
              )}
              <CDIcon
                name="chevronDown"
                size={13}
                className="cd-orders-filter-chevron"
              />
            </button>

            {filtersOpen && (
              <div
                id={filterPanelId}
                ref={filterPopRef}
                className="cd-orders-filter-pop"
                role="region"
                aria-label={`${filterLabel} filters`}
              >
                {filterChildren}
              </div>
            )}
          </div>
          )}
        </div>

        {(viewExtras || onExport) && (
          <div className="cd-orders-toolbar-actions">
            {viewExtras}
            {onExport && (
              <Btn small icon="download" onClick={onExport}>
                {exportLabel}
              </Btn>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function OrderListTable({
  loading,
  error,
  empty,
  filtered,
  minWidth,
  columns,
  headers,
  emptyIcon,
  emptyTitle,
  emptySub,
  emptyActionLabel,
  onEmptyAction,
  filteredTitle = "No results match this view",
  filteredSub = "Try another view, search, or filter.",
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  filtered: boolean;
  minWidth: number;
  columns: string;
  headers: ReactNode;
  emptyIcon: string;
  emptyTitle: string;
  emptySub?: string;
  // Optional call-to-action on the unfiltered empty state (e.g. "New product" on an empty
  // catalog); never shown on the filtered empty state, where clearing filters is the way out.
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  filteredTitle?: string;
  filteredSub?: string;
  children: ReactNode;
}) {
  if (loading && empty) {
    return (
      <div className="cd-orders-table cd-orders-state">
        <TableSkeleton rows={6} />
      </div>
    );
  }

  if (error && empty) {
    return (
      <div className="cd-orders-table cd-orders-state" role="alert">
        <Placeholder icon="warn" title="Couldn’t load this list" sub={error} />
      </div>
    );
  }

  if (empty) {
    return (
      <div className="cd-orders-table cd-orders-state">
        <Placeholder
          icon={filtered ? "search" : emptyIcon}
          title={filtered ? filteredTitle : emptyTitle}
          sub={filtered ? filteredSub : emptySub}
          actionLabel={filtered ? undefined : emptyActionLabel}
          onAction={filtered ? undefined : onEmptyAction}
        />
      </div>
    );
  }

  return (
    <div className="cd-orders-table">
      {error && (
        <div className="cd-orders-inline-error" role="status">
          <CDIcon name="warn" size={14} strokeWidth={1.9} />
          Couldn’t refresh · showing the last loaded data
        </div>
      )}
      <Pan min={minWidth}>
        <div className="cd-tablehd" style={{ gridTemplateColumns: columns }}>
          {headers}
        </div>
        {children}
      </Pan>
    </div>
  );
}

export function OrderBulkBar({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  const visible = count > 0;
  const [mounted, setMounted] = useState(visible);
  const ref = useRef<HTMLDivElement>(null);
  const wasVisible = useRef(false);

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el || !mounted) return;
      const was = wasVisible.current;
      wasVisible.current = visible;

      if (reduced()) {
        if (!visible) setMounted(false);
        return;
      }
      if (was === visible) return;
      if (visible) {
        gsap.fromTo(
          el,
          { autoAlpha: 0, y: -7, willChange: "transform,opacity" },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.24,
            ease: "power2.out",
            clearProps: "opacity,visibility,transform,willChange",
          },
        );
      } else {
        gsap.to(el, {
          autoAlpha: 0,
          y: -7,
          duration: 0.16,
          ease: "power2.in",
          onComplete: () => setMounted(false),
        });
      }
    },
    { dependencies: [mounted, visible], scope: ref },
  );

  if (!mounted) return null;
  return (
    <div ref={ref} className="cd-bulkbar" aria-live="polite">
      <span className="cd-row-title tabular-nums">{count} selected</span>
      {children}
    </div>
  );
}

export function OrderListPagination({
  start,
  end,
  total,
  onPrevious,
  onNext,
}: {
  start: number;
  end: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const summaryRef = useRef<HTMLSpanElement>(null);
  useGSAP(
    () => {
      if (reduced() || !summaryRef.current) return;
      gsap.fromTo(
        summaryRef.current,
        { opacity: 0.35, y: 2 },
        { opacity: 1, y: 0, duration: 0.2, ease: "power1.out" },
      );
    },
    {
      dependencies: [start, end, total],
      scope: summaryRef,
      revertOnUpdate: true,
    },
  );

  return (
    <div className="cd-orders-pagination">
      <span ref={summaryRef} className="cd-caption tabular-nums">
        Showing {start}-{end} of {total.toLocaleString("en-US")}
      </span>
      <div className="cd-orders-pagination-actions">
        <Btn small disabled={start <= 1} onClick={onPrevious}>
          Prev
        </Btn>
        <Btn small disabled={end >= total} onClick={onNext}>
          Next
        </Btn>
      </div>
    </div>
  );
}
