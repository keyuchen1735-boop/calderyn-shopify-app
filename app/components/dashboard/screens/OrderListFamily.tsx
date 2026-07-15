import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import { CDIcon } from "../icons";
import { Btn, Pan, Placeholder, TableSkeleton } from "../ui";
import { reduced } from "../hero/hero-motion";

export interface OrderListView {
  id: string;
  label: string;
}

export interface OrderListSortOption {
  value: string;
  label: string;
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
  sortOptions,
  sort,
  dir,
  onSortChange,
  onDirChange,
  activeFilterCount,
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
  sortOptions: OrderListSortOption[];
  sort: string;
  dir: "asc" | "desc";
  onSortChange: (sort: string) => void;
  onDirChange: (dir: "asc" | "desc") => void;
  activeFilterCount: number;
  filterLabel: string;
  filterChildren: ReactNode;
  exportLabel?: string;
  onExport: () => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterToggleRef = useRef<HTMLButtonElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const filterPanelWasOpen = useRef(false);
  const filterPanelId = useId();

  useEffect(() => {
    const panel = filterPanelRef.current;
    if (!panel) return;
    if (filtersOpen) panel.removeAttribute("inert");
    else panel.setAttribute("inert", "");
  }, [filtersOpen]);

  useGSAP(
    () => {
      const el = filterPanelRef.current;
      if (!el) return;
      const inner = el.firstElementChild as HTMLElement | null;
      const was = filterPanelWasOpen.current;
      filterPanelWasOpen.current = filtersOpen;

      if (reduced() || was === filtersOpen) {
        el.style.height = filtersOpen ? "auto" : "0px";
        el.style.opacity = filtersOpen ? "1" : "0";
        return;
      }

      const full = inner ? inner.offsetHeight : el.scrollHeight;
      if (filtersOpen) {
        gsap.set(el, {
          height: 0,
          opacity: 0,
          y: -4,
          willChange: "height,transform,opacity",
        });
        gsap.to(el, {
          height: full,
          opacity: 1,
          y: 0,
          duration: 0.22,
          ease: "power2.out",
          onComplete: () => {
            el.style.height = "auto";
            el.style.removeProperty("transform");
            el.style.removeProperty("will-change");
          },
        });
      } else {
        gsap.set(el, { willChange: "height,transform,opacity" });
        gsap.to(el, {
          height: 0,
          opacity: 0,
          y: -4,
          duration: 0.16,
          ease: "power2.in",
          onComplete: () => {
            el.style.removeProperty("transform");
            el.style.removeProperty("will-change");
          },
        });
      }
    },
    { dependencies: [filtersOpen], scope: filterPanelRef },
  );

  return (
    <div className="cd-orders-toolbar">
      <div className="cd-orders-view-row">
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
        {viewExtras && (
          <div className="cd-orders-view-extras">{viewExtras}</div>
        )}
      </div>

      <div className="cd-orders-toolbar-row">
        <div className="cd-orders-toolbar-primary">
          <div className="cd-orders-search">
            <CDIcon name="search" size={14} strokeWidth={1.8} />
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
          <button
            ref={filterToggleRef}
            type="button"
            className="cd-btn cd-btn-secondary cd-btn-sm cd-orders-filter-toggle"
            aria-expanded={filtersOpen}
            aria-controls={filterPanelId}
            onClick={() => {
              if (
                filtersOpen &&
                filterPanelRef.current?.contains(document.activeElement)
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
        </div>

        <div className="cd-orders-toolbar-actions">
          <select
            className="cd-input cd-orders-sort"
            aria-label="Sort by"
            value={sort}
            onChange={(event) => onSortChange(event.target.value)}
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Btn
            small
            className="cd-btn-icon"
            icon={dir === "asc" ? "arrowUp" : "arrowDown"}
            ariaLabel={dir === "asc" ? "Sort ascending" : "Sort descending"}
            onClick={() => onDirChange(dir === "asc" ? "desc" : "asc")}
          >
            {""}
          </Btn>
          <Btn small icon="download" onClick={onExport}>
            {exportLabel}
          </Btn>
        </div>
      </div>

      <div
        id={filterPanelId}
        ref={filterPanelRef}
        className="cd-orders-filter-panel"
        role="region"
        aria-label={`${filterLabel} filters`}
        aria-hidden={!filtersOpen}
      >
        <div className="cd-orders-filter-panel-inner">{filterChildren}</div>
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
