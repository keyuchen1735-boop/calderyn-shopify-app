import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Btn, Card, Pan, Placeholder, TableSkeleton } from "../ui";
import { money, timeAgo } from "../format";
import { reduced } from "../hero/hero-motion";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  bulkAddOrderTags,
  bulkArchiveOrders,
  bulkFulfillOrders,
  createOrderView,
  deleteOrderView,
  fetchOrderViews,
  fetchOrdersList,
  fetchOrdersPage,
  ordersListParamsToQueryString,
  sendOrderRecoveryEmail,
  type BulkResultVM,
  type OrderRow,
  type OrderViewVM,
  type OrdersListParams,
  type OrdersPage,
  type UnifiedOrderRow,
  type UnifiedOrdersPage,
} from "~/lib/dashboard/orders-client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import type { DashboardCtx } from "../context";
import RefundModal from "./RefundModal";
import OrderDetailScreen from "./OrderDetail";
import OrderComposer from "./OrderComposer";
import OrdersToolbar from "./OrdersToolbar";
import { CDIcon } from "../icons";
import { fulfillmentBadge, isStuckUnfulfilled, paymentPillStyle, REFUNDABLE_ORDER_STATES, stuckDays } from "./order-status";
import { isPrefillParam } from "./order-composer-prefill";
import {
  isSystemView,
  paramsToViewFilters,
  stateToParams,
  viewFiltersToParams,
  type ListFilterPatch,
  type ListState,
} from "./orders-list-state";

const ORDER_SECTION_META: Record<string, { title: string; sub: string }> = {
  orders: { title: "Orders", sub: "Storefront and Shopify orders, in one place." },
  labels: { title: "Shipping charges", sub: "Shipping costs matched to their orders." },
  drafts: { title: "Draft carts", sub: "Customer carts still in progress." },
  abandoned: { title: "Abandoned checkouts", sub: "Checkouts ready for recovery." },
};

const ORDER_TABLE_COLUMNS = "36px 112px minmax(190px, 1.5fr) 96px 88px 112px 132px 88px";

function PaymentPill({ status }: { status: string }) {
  const s = paymentPillStyle(status);
  const active = status === "paid" || status === "authorized";
  return <span className={`cd-badge${active ? " cd-order-badge-live" : ""}`}>{s.label}</span>;
}

// One display row across both origins: native Calderyn orders and migrated
// Shopify orders render in a single unified list, newest first.
type DisplayOrder = {
  id: string;
  ref: string;
  createdAt: string | null;
  customer: string | null;
  totalCents: number;
  currency: string;
  // Native: the OrderState lifecycle enum (paid/partially_fulfilled/fulfilled/cancelled/...) —
  // drives the Fulfillment badge. Imported: the same value as financialStatus (Shopify never
  // hands this surface a separate lifecycle state), so its Fulfillment badge is always skipped.
  state: string;
  // financial_status vocabulary (paid/refunded/partially_refunded/...) — drives the Payment pill
  // for BOTH origins.
  financialStatus: string;
  cancelledAt: string | null;
  source: "calderyn" | "shopify";
  // The native OrderRow (for the refund modal) when this row is a Calderyn
  // order; null for migrated orders (their money lives at Shopify).
  refundRow: OrderRow | null;
};

/** `orders/<sourceId>` id for a display row — `shopify:`-prefixed for migrated orders, matching
 *  the prefix loadOrderDetail (detail.server.ts) and the write routes expect. */
function displayOrderSourceId(r: DisplayOrder): string {
  return r.source === "shopify" ? `shopify:${r.id}` : r.id;
}

/** UnifiedOrderRow (the unified list read model) -> the DisplayOrder shape the row renderer and
 *  the RefundModal already understand, so both survive the switch from the client-side
 *  native+imported merge to the server's single unified query. */
function unifiedRowToDisplayOrder(row: UnifiedOrderRow): DisplayOrder {
  return {
    id: row.id,
    ref: row.ref,
    createdAt: row.occurredAt,
    customer: row.buyerEmail,
    totalCents: row.totalCents,
    currency: row.currency,
    state: row.state,
    financialStatus: row.paymentStatus,
    cancelledAt: row.cancelledAt,
    source: row.source,
    refundRow:
      row.source === "calderyn"
        ? {
            id: row.id,
            ref: row.ref,
            buyerEmail: row.buyerEmail,
            itemCount: row.itemCount,
            totalCents: row.totalCents,
            remainingRefundableCents: row.remainingRefundableCents,
            currency: row.currency,
            attribution: null,
            state: row.state,
            financialStatus: row.paymentStatus,
            createdAt: row.occurredAt,
          }
        : null,
  };
}

function UnifiedOrdersList({
  rows,
  loading,
  isDefaultView,
  onRefund,
  onOpen,
  selected,
  onToggleRow,
  onToggleAll,
  allSelected,
  anySelectable,
}: {
  rows: DisplayOrder[] | null;
  loading: boolean;
  isDefaultView: boolean;
  onRefund: (order: OrderRow) => void;
  onOpen: (sourceId: string) => void;
  selected: Set<string>;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  allSelected: boolean;
  anySelectable: boolean;
}) {
  if (rows == null) {
    return (
      <div className="cd-orders-table">
        {loading ? (
          <TableSkeleton />
        ) : (
          <Placeholder
            icon="doc"
            title="Orders unavailable"
            sub="Could not load orders just now. Refresh to try again."
          />
        )}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="cd-orders-table">
        <Placeholder
          icon="doc"
          title={isDefaultView ? "No orders yet" : "No orders match this view."}
          sub={
            isDefaultView
              ? "Orders from your storefront and from AI shopping assistants land here."
              : "Try a different search, tab, or clear your filters."
          }
        />
      </div>
    );
  }

  const cols = ORDER_TABLE_COLUMNS;
  return (
    <div className="cd-orders-table">
      <Pan min={880}>
      <div className="cd-tablehd" style={{ gridTemplateColumns: cols }}>
        <span>
          {anySelectable && (
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleAll}
              aria-label="Select all orders on this page"
            />
          )}
        </span>
        <span>Order</span>
        <span>Customer</span>
        <span style={{ textAlign: "right" }}>Total</span>
        <span>Date</span>
        <span>Payment</span>
        <span>Fulfillment</span>
        <span />
      </div>
      {rows.map((r) => {
        const refundable = r.refundRow && REFUNDABLE_ORDER_STATES.has(r.state) ? r.refundRow : null;
        const fulfillment = r.source === "calderyn" ? fulfillmentBadge(r.state, r.cancelledAt) : null;
        // Stuck-unfulfilled badge: native orders only, paid > 3 days with nothing shipped.
        const now = Date.now();
        const stuck = r.source === "calderyn" && r.createdAt ? isStuckUnfulfilled(r.state, r.createdAt, now) : false;
        const stuckN = stuck && r.createdAt ? stuckDays(r.createdAt, now) : null;
        const open = () => onOpen(displayOrderSourceId(r));
        const selectableId = r.source === "calderyn" ? r.id : null;
        return (
          <div
            key={`${r.source}:${r.id}`}
            className="cd-trow cd-order-row"
            data-selected={selectableId && selected.has(selectableId) ? "1" : "0"}
            style={{ gridTemplateColumns: cols, cursor: "pointer" }}
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                open();
              }
            }}
          >
            <div onClick={(e) => e.stopPropagation()}>
              {selectableId ? (
                <input
                  type="checkbox"
                  checked={selected.has(selectableId)}
                  onChange={() => onToggleRow(selectableId)}
                  aria-label={`Select order ${r.ref}`}
                />
              ) : (
                // Imported (Shopify) rows aren't bulk-selectable — an empty span keeps the grid
                // column aligned without a stray placeholder glyph in a screen reader's way.
                <span className="cd-caption" aria-hidden="true" />
              )}
            </div>
            <div className="cd-order-ref-cell">
              <span className="cd-row-title tabular-nums truncate">{r.ref}</span>
              {r.source === "shopify" && <span className="cd-order-source-label">Shopify</span>}
            </div>
            <div className="truncate">{r.customer ?? (r.source === "shopify" ? "" : "Guest")}</div>
            <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
              {money(r.totalCents, r.currency)}
            </div>
            <div className="cd-caption">{r.createdAt ? timeAgo(r.createdAt) : ""}</div>
            <div>
              <PaymentPill status={r.financialStatus} />
            </div>
            <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap" }}>
              {fulfillment && (
                <span className={`cd-badge${stuckN != null ? " cd-order-badge-live" : ""}`}>
                  {fulfillment.label}{stuckN != null ? ` · ${stuckN}d` : ""}
                </span>
              )}
            </div>
            <div
              className="cd-order-row-actions"
              onClick={(e) => e.stopPropagation()}
            >
              {refundable ? (
                <Btn small icon="rotate" onClick={() => onRefund(refundable)}>
                  Refund
                </Btn>
              ) : (
                <CDIcon name="chevronRight" size={15} className="cd-order-row-chevron" />
              )}
            </div>
          </div>
        );
      })}
      </Pan>
    </div>
  );
}

export default function Orders({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints the last page
  // instantly; the mount fetch below revalidates and writes back through.
  const [page, setPage] = useState<OrdersPage | null>(() =>
    cachedScreenData<OrdersPage>(SCREEN_CACHE_KEYS.orders),
  );
  const [loading, setLoading] = useState(true);
  const [refundOrder, setRefundOrder] = useState<OrderRow | null>(null);
  const toast = app.toast;

  const load = useCallback(
    (signal?: { alive: boolean }) => {
      setLoading(true);
      fetchOrdersPage()
        .then((p) => {
          cacheScreenData(SCREEN_CACHE_KEYS.orders, p);
          if (!signal || signal.alive) setPage(p);
        })
        .catch((err: unknown) => {
          if (signal && !signal.alive) return;
          const msg = err instanceof DashboardApiError ? err.message : "Could not load orders.";
          toast(msg, "warn", "critical");
        })
        .finally(() => {
          if (!signal || signal.alive) setLoading(false);
        });
    },
    [toast],
  );

  useEffect(() => {
    const signal = { alive: true };
    load(signal);
    return () => {
      signal.alive = false;
    };
  }, [load]);

  // --- unified orders list: search/filter/sort/paginate (Phase 2 Task 6) ------------------------
  const [state, setState] = useState<ListState>({
    view: "all",
    search: "",
    sort: undefined,
    dir: undefined,
    offset: 0,
  });
  const [searchInput, setSearchInput] = useState("");
  const [savedViews, setSavedViews] = useState<OrderViewVM[]>([]);
  const [ordersListPage, setOrdersListPage] = useState<UnifiedOrdersPage | null>(() =>
    cachedScreenData<UnifiedOrdersPage>(SCREEN_CACHE_KEYS.ordersList),
  );
  const [ordersListLoading, setOrdersListLoading] = useState(true);

  // Debounce the search box so each keystroke doesn't fire a request; every effective search
  // change resets to page 1 (see the offset reset below).
  useEffect(() => {
    const t = setTimeout(() => {
      setState((s) => {
        const trimmed = searchInput.trim();
        if (s.search === trimmed) return s;
        return { ...s, search: trimmed, offset: 0 };
      });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    let alive = true;
    fetchOrderViews()
      .then((views) => {
        if (alive) setSavedViews(views);
      })
      .catch(() => {
        /* saved views are additive — the toolbar still works off the system tabs */
      });
    return () => {
      alive = false;
    };
  }, []);

  const effectiveParams = useMemo<OrdersListParams>(
    () => stateToParams(state, savedViews),
    [state, savedViews],
  );

  // Whether any of the manually-picked toolbar filter controls (Fix 3) carry a value — used both
  // to widen isDefaultView/isPlainSystemTab below and to gate the Save view button.
  const hasManualFilters =
    !!state.paymentStatus?.length ||
    !!state.fulfillmentStatus ||
    !!state.source ||
    !!state.dateFrom ||
    !!state.dateTo;

  // Only the bare "all" tab, no search, first page, default sort, no manual filter controls seeds
  // from + writes through the screen cache — any other combination is a live fetch (never
  // cached), so a saved filter never paints stale data from a totally different view.
  const isDefaultView =
    state.view === "all" &&
    !state.search &&
    state.offset === 0 &&
    state.sort === undefined &&
    state.dir === undefined &&
    !hasManualFilters;
  const isArchivedView = effectiveParams.archived === true;
  const isPlainSystemTab =
    isSystemView(state.view) &&
    !state.search &&
    state.sort === undefined &&
    state.dir === undefined &&
    !hasManualFilters;
  const canSaveView = !isPlainSystemTab;

  const loadOrdersList = useCallback(
    (params: OrdersListParams, isDefault: boolean, signal?: { alive: boolean }) => {
      setOrdersListLoading(true);
      fetchOrdersList(params)
        .then((p) => {
          if (isDefault) cacheScreenData(SCREEN_CACHE_KEYS.ordersList, p);
          if (signal && !signal.alive) return;
          setOrdersListPage(p);
          // Offset stranded past the end of the (now-shrunk) result set — e.g. bulk-archiving
          // every order on the last page of a filtered view. Step back one page and let the
          // effect below refetch, rather than showing a dead "no orders" empty state the merchant
          // has to manually back out of. Guarded to only ever step toward 0 (never below it), and
          // only fires when we're actually past the first page, so a genuinely empty view (offset
          // already 0) can't loop.
          if (p.rows.length === 0 && p.offset > 0) {
            setState((s) => ({ ...s, offset: Math.max(0, p.offset - p.limit) }));
          }
        })
        .catch((err: unknown) => {
          if (signal && !signal.alive) return;
          const msg = err instanceof DashboardApiError ? err.message : "Could not load orders.";
          toast(msg, "warn", "critical");
        })
        .finally(() => {
          if (!signal || signal.alive) setOrdersListLoading(false);
        });
    },
    [toast],
  );

  useEffect(() => {
    const signal = { alive: true };
    loadOrdersList(effectiveParams, isDefaultView, signal);
    return () => {
      signal.alive = false;
    };
  }, [effectiveParams, isDefaultView, loadOrdersList]);

  // Latest resolved filters, readable from the (rare-firing) back-from-detail effect below without
  // making that effect re-run on every keystroke/filter change.
  const listParamsRef = useRef({ params: effectiveParams, isDefault: isDefaultView });
  listParamsRef.current = { params: effectiveParams, isDefault: isDefaultView };

  const selectView = useCallback(
    (next: string) => {
      if (isSystemView(next)) {
        setState((s) => ({ ...s, view: next, offset: 0 }));
        return;
      }
      const saved = savedViews.find((v) => v.id === next);
      const filters = saved ? viewFiltersToParams(saved.filters) : {};
      setSearchInput(filters.search ?? "");
      setState((s) => ({
        ...s,
        view: next,
        search: filters.search ?? "",
        paymentStatus: filters.paymentStatus,
        fulfillmentStatus: filters.fulfillmentStatus,
        source: filters.source,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        sort: filters.sort,
        dir: filters.dir,
        offset: 0,
      }));
    },
    [savedViews],
  );

  // Fix 3's simplest-coherent rule: a saved view is a single frozen filter preset, so the moment
  // the merchant touches one of the manual toolbar filter controls while a saved view is active,
  // fall back to the "all" baseline with that one filter now applied on top of it — rather than
  // silently mutating the saved view's own stored filters, or leaving the control's edit inert.
  // System tabs don't need this: stateToParams already lets a system tab's own dimension win over
  // a manual control on that same dimension, so touching an unrelated filter there just composes.
  const updateFilter = useCallback((patch: ListFilterPatch) => {
    setState((s) => ({
      ...s,
      ...patch,
      view: isSystemView(s.view) ? s.view : "all",
      offset: 0,
    }));
  }, []);

  const saveCurrentView = useCallback(
    async (name: string) => {
      const filtersToSave = paramsToViewFilters(effectiveParams);
      try {
        const view = await createOrderView(name, filtersToSave);
        setSavedViews((vs) => [...vs, view]);
        toast(`Saved view "${view.name}".`, "check", "success");
      } catch (err) {
        toast(err instanceof DashboardApiError ? err.message : "Couldn't save this view.", "warn", "critical");
      }
    },
    [effectiveParams, toast],
  );

  const removeView = useCallback(
    async (id: string) => {
      try {
        await deleteOrderView(id);
        setSavedViews((vs) => vs.filter((v) => v.id !== id));
        setState((s) => (s.view === id ? { ...s, view: "all", offset: 0 } : s));
        toast("View deleted.", "check", "success");
      } catch (err) {
        toast(err instanceof DashboardApiError ? err.message : "Couldn't delete this view.", "warn", "critical");
      }
    },
    [toast],
  );

  const exportHref = useMemo(() => {
    const qs = ordersListParamsToQueryString({ ...effectiveParams, offset: undefined, limit: undefined });
    return `/dashboard/api/orders/export${qs ? `?${qs}` : ""}`;
  }, [effectiveParams]);

  const displayRows = useMemo(
    () => (ordersListPage ? ordersListPage.rows.map(unifiedRowToDisplayOrder) : null),
    [ordersListPage],
  );

  // Subtle staggered rise on every fresh page of rows — initial load, a tab switch, a filter
  // change, paging. Keyed on the page object itself (a new reference every fetch), scoped to just
  // this table so it can never pick up a `.cd-trow` from an unrelated screen.
  const listRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (reduced() || !displayRows || displayRows.length === 0 || !listRef.current) return;
      const rows = listRef.current.querySelectorAll<HTMLElement>(".cd-trow");
      if (!rows.length) return;
      gsap.from(rows, {
        autoAlpha: 0,
        y: 6,
        duration: 0.25,
        stagger: 0.02,
        ease: "power2.out",
        clearProps: "opacity,visibility,transform",
      });
    },
    { dependencies: [ordersListPage] },
  );

  // A very quick fade on the "Showing X-Y of N" summary when the range or total changes — a small
  // acknowledgement that the count just moved, never a count-up (money/counts here are exact, not
  // animated toward).
  const pageSummaryRef = useRef<HTMLSpanElement>(null);
  const pageSummaryKey = ordersListPage
    ? `${ordersListPage.offset}:${ordersListPage.rows.length}:${ordersListPage.totalCount}`
    : null;
  const pageSummarySeen = useRef<string | null>(null);
  useGSAP(
    () => {
      const prev = pageSummarySeen.current;
      pageSummarySeen.current = pageSummaryKey;
      if (reduced() || !pageSummaryKey || prev === null || prev === pageSummaryKey || !pageSummaryRef.current) return;
      gsap.fromTo(pageSummaryRef.current, { opacity: 0.35 }, { opacity: 1, duration: 0.2, ease: "power1.out" });
    },
    { dependencies: [pageSummaryKey] },
  );

  const selectableIds = useMemo(
    () => (displayRows ?? []).filter((r) => r.source === "calderyn").map((r) => r.id),
    [displayRows],
  );
  const refById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of displayRows ?? []) if (r.source === "calderyn") m.set(r.id, r.ref);
    return m;
  }, [displayRows]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [ordersListPage]);

  // Bulk bar slide/fade: kept mounted for the duration of its exit tween rather than vanishing the
  // instant the selection clears, so "out" is an actual animation and not a instant unmount. The
  // `bulkMounted && !hasSelection` bail-out below is the standard React "adjust state while
  // rendering" pattern — it commits mount and hasSelection together in one paint, so the entrance
  // tween's ref is never null on the frame it's meant to run.
  const hasSelection = selected.size > 0;
  const [bulkMounted, setBulkMounted] = useState(false);
  if (hasSelection && !bulkMounted) setBulkMounted(true);
  const bulkBarRef = useRef<HTMLDivElement>(null);
  const bulkWasOpen = useRef(false);
  useGSAP(
    () => {
      const el = bulkBarRef.current;
      if (!el) return;
      const was = bulkWasOpen.current;
      bulkWasOpen.current = hasSelection;
      if (reduced()) {
        if (!hasSelection) setBulkMounted(false);
        return;
      }
      if (was === hasSelection) return;
      if (hasSelection) {
        gsap.fromTo(el, { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: 0.25, ease: "power2.out" });
      } else {
        gsap.to(el, {
          autoAlpha: 0,
          y: -8,
          duration: 0.18,
          ease: "power2.in",
          onComplete: () => setBulkMounted(false),
        });
      }
    },
    { dependencies: [hasSelection] },
  );

  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const allOn = selectableIds.length > 0 && selectableIds.every((id) => prev.has(id));
      return new Set(allOn ? [] : selectableIds);
    });
  }, [selectableIds]);

  const [bulkBusy, setBulkBusy] = useState(false);
  // Defaults OFF: a bulk fulfill can send up to 25 shipping-confirmation emails on one click, so
  // opt-in beats opt-out here. The single-order FulfillModal is a deliberate, reviewed action on
  // one order at a time, so it keeps its own default of ON.
  const [notifyOnFulfill, setNotifyOnFulfill] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState("");

  const summarizeBulk = useCallback(
    (results: BulkResultVM[], verb: string) => {
      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast(`${ok.length} ${verb}.`, "check", "success");
        return;
      }
      toast(`${ok.length} of ${results.length} ${verb}. ${failed.length} failed.`, "warn", "critical");
      if (failed.length <= 3) {
        const refs = failed.map((f) => refById.get(f.orderId) ?? f.orderId).join(", ");
        toast(`Failed: ${refs}`, "warn", "critical");
      } else {
        toast("Check the orders.", "warn", "critical");
      }
    },
    [refById, toast],
  );

  const bulkFulfill = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0 || bulkBusy) return;
    if (!window.confirm(`Mark ${ids.length} orders fulfilled?`)) return;
    setBulkBusy(true);
    try {
      const { results } = await bulkFulfillOrders(ids, notifyOnFulfill, crypto.randomUUID());
      summarizeBulk(results, "fulfilled");
      loadOrdersList(effectiveParams, isDefaultView);
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "Couldn't fulfill these orders.", "warn", "critical");
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkArchive = async (archived: boolean) => {
    const ids = Array.from(selected);
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const { results } = await bulkArchiveOrders(ids, archived);
      summarizeBulk(results, archived ? "archived" : "unarchived");
      loadOrdersList(effectiveParams, isDefaultView);
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "Couldn't update these orders.", "warn", "critical");
    } finally {
      setBulkBusy(false);
    }
  };

  // Abandoned tab: manual recovery-email resend. Honest, reason-specific toasts (rather than a
  // generic failure) when sendOrderRecoveryEmail resolves {sent:false, reason} — the same
  // eligibility checks the automatic sweep applies (recovery.server.ts), surfaced plainly rather
  // than as an opaque error.
  const [recoverySending, setRecoverySending] = useState<Set<string>>(new Set());
  const sendRecovery = async (orderId: string) => {
    if (recoverySending.has(orderId)) return;
    setRecoverySending((prev) => new Set(prev).add(orderId));
    try {
      const result = await sendOrderRecoveryEmail(orderId);
      if (result.sent) {
        toast("Recovery email sent.", "check");
        setPage((prev) =>
          prev
            ? {
                ...prev,
                abandoned: prev.abandoned.map((r) =>
                  r.id === orderId ? { ...r, recoveryEmailSentAt: new Date().toISOString() } : r,
                ),
              }
            : prev,
        );
      } else if (result.reason === "no_consent") {
        toast("This customer has not opted into marketing emails.", "warn");
      } else if (result.reason === "no_storefront_origin") {
        toast("Your storefront domain is not set up yet.", "warn");
      } else if (result.reason === "no_buyer_email") {
        toast("This checkout has no customer email on file.", "warn");
      } else if (result.reason === "not_recoverable") {
        toast("This checkout can't be recovered anymore.", "warn");
      } else if (result.reason === "already_sent") {
        toast("A recovery email was already sent.", "warn");
      } else {
        toast("Couldn't send the recovery email.", "warn", "critical");
      }
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "Couldn't send the recovery email.", "warn", "critical");
    } finally {
      setRecoverySending((prev) => {
        const next = new Set(prev);
        next.delete(orderId);
        return next;
      });
    }
  };

  const bulkAddTag = async () => {
    const tag = bulkTagInput.trim();
    const ids = Array.from(selected);
    if (!tag || ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const { results } = await bulkAddOrderTags(ids, [tag]);
      summarizeBulk(results, "tagged");
      setBulkTagInput("");
      loadOrdersList(effectiveParams, isDefaultView);
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "Couldn't tag these orders.", "warn", "critical");
    } finally {
      setBulkBusy(false);
    }
  };

  // Order-detail actions (fulfill/cancel/refund/archive) mutate the native list this screen
  // already holds in memory, so a plain return-to-list doesn't see the change until a refetch.
  // Rather than thread an onChanged callback through every modal on the detail screen, this
  // component (which owns `load`) just refetches the moment nav.param goes from "viewing an
  // order" back to null — i.e. on the Back button, wherever the visit came from.
  const wasViewingOrder = useRef(false);
  useEffect(() => {
    if (app.nav.param) {
      wasViewingOrder.current = true;
      return;
    }
    if (wasViewingOrder.current) {
      wasViewingOrder.current = false;
      load();
      loadOrdersList(listParamsRef.current.params, listParamsRef.current.isDefault);
    }
  }, [app.nav.param, load, loadOrdersList]);

  const sub = app.nav.sub ?? "orders";
  const sectionMeta = ORDER_SECTION_META[sub] ?? ORDER_SECTION_META.orders;
  const overviewItems = useMemo<Array<{ label: string; value: string; action?: () => void }>>(() => {
    if (sub === "orders") {
      if (!displayRows && !ordersListPage) return [];
      const rows = displayRows ?? [];
      const now = Date.now();
      const attention = rows.filter((row) =>
        row.financialStatus === "pending" ||
        (row.source === "calderyn" && row.createdAt && isStuckUnfulfilled(row.state, row.createdAt, now)),
      ).length;
      return [
        { label: "Orders", value: (ordersListPage?.totalCount ?? rows.length).toLocaleString("en-US") },
        { label: "Page value", value: money(rows.reduce((sum, row) => sum + row.totalCents, 0), rows[0]?.currency ?? "usd") },
        { label: "Needs action", value: attention.toLocaleString("en-US"), action: () => selectView("unfulfilled") },
      ];
    }
    if (!page) return [];
    if (sub === "labels") {
      return [
        { label: "Charges", value: page.shipCharges.length.toLocaleString("en-US") },
        { label: "Recorded cost", value: money(page.shipCharges.reduce((sum, row) => sum + row.costCents, 0)) },
        { label: "Unmatched", value: page.shipCharges.filter((row) => !row.matched).length.toLocaleString("en-US") },
      ];
    }
    if (sub === "drafts") {
      return [
        { label: "Carts", value: page.drafts.length.toLocaleString("en-US") },
        { label: "Cart value", value: money(page.drafts.reduce((sum, row) => sum + row.valueCents, 0), page.drafts[0]?.currency ?? "usd") },
        { label: "Identified", value: page.drafts.filter((row) => row.buyerEmail).length.toLocaleString("en-US") },
      ];
    }
    return [
      { label: "Checkouts", value: page.abandoned.length.toLocaleString("en-US") },
      { label: "Potential value", value: money(page.abandoned.reduce((sum, row) => sum + row.totalCents, 0), page.abandoned[0]?.currency ?? "usd") },
      { label: "Unsent", value: page.abandoned.filter((row) => !row.recoveryEmailSentAt).length.toLocaleString("en-US") },
    ];
  }, [displayRows, ordersListPage, page, selectView, sub]);

  const overviewRef = useRef<HTMLDivElement>(null);
  const overviewKey = overviewItems.map((item) => `${item.label}:${item.value}`).join("|");
  const sectionPanelRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (reduced() || !overviewRef.current) return;
      const items = overviewRef.current.querySelectorAll<HTMLElement>(".cd-order-readout-item");
      gsap.fromTo(
        items,
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
    { dependencies: [overviewKey], scope: overviewRef, revertOnUpdate: true },
  );
  useGSAP(
    () => {
      if (reduced() || !sectionPanelRef.current) return;
      gsap.from(sectionPanelRef.current, {
        autoAlpha: 0,
        y: 5,
        duration: 0.2,
        ease: "power2.out",
        willChange: "transform,opacity",
        clearProps: "opacity,visibility,transform,willChange",
      });
    },
    { dependencies: [sub], scope: sectionPanelRef, revertOnUpdate: true },
  );

  // Reserved param "new" -> the Create-order composer, same idiom as Campaigns' navigate("campaigns",
  // "new"). A "new_<orderId>_<returnId>" param (order-composer-prefill.ts) is the SAME composer
  // with a replacement-order prefill (Phase 4 Task 2, from a closed return's "Create replacement
  // order" button) — isPrefillParam only matches that reserved shape, never a bare order sourceId.
  // Must be checked BEFORE the row-click/deep-link branch below, which otherwise treats any
  // non-null param as an order's sourceId.
  if (app.nav.param === "new" || (app.nav.param && isPrefillParam(app.nav.param))) {
    return <OrderComposer app={app} prefillParam={app.nav.param === "new" ? null : app.nav.param} />;
  }

  // Row-click / deep-link: nav.param carries the selected order's sourceId (`shopify:<id>` for
  // migrated orders, a bare id for native ones) — same idiom as Campaigns' selected-campaign branch.
  if (app.nav.param) {
    const seedRow = (displayRows ?? []).find((r) => displayOrderSourceId(r) === app.nav.param) ?? null;
    return (
      <OrderDetailScreen
        app={app}
        sourceId={app.nav.param}
        seed={
          seedRow
            ? {
                ref: seedRow.ref,
                totalCents: seedRow.totalCents,
                currency: seedRow.currency,
                createdAt: seedRow.createdAt,
                source: seedRow.source,
                state: seedRow.state,
                financialStatus: seedRow.financialStatus,
              }
            : null
        }
      />
    );
  }

  return (
    <div className="cd-screen cd-orders-screen" data-screen-label="Orders" data-sub={sub}>
      <header className="cd-screen-head cd-order-page-head">
        <div>
          <h1 className="cd-h1">{sectionMeta.title}</h1>
          <p className="cd-sub">{sectionMeta.sub}</p>
        </div>
        <Btn kind="primary" small onClick={() => app.navigate("orders", "new")}>
          Create order
        </Btn>
      </header>

      {overviewItems.length > 0 && (
        <div ref={overviewRef} className="cd-order-readout" aria-label={`${sectionMeta.title} overview`}>
          {overviewItems.map((item) => {
            const content = (
              <>
                <strong className="tabular-nums">{item.value}</strong>
                <span>{item.label}</span>
                {item.action && <CDIcon name="arrowRight" size={14} strokeWidth={1.9} />}
              </>
            );
            return item.action ? (
              <button key={item.label} type="button" className="cd-order-readout-item" data-action="1" onClick={item.action}>
                {content}
              </button>
            ) : (
              <div key={item.label} className="cd-order-readout-item">
                {content}
              </div>
            );
          })}
        </div>
      )}

      <div ref={sectionPanelRef} className="cd-order-section-panel">
      {sub === "orders" ? (
        <Card pad={false} className="cd-order-workspace">
          <OrdersToolbar
            view={state.view}
            savedViews={savedViews}
            onViewChange={selectView}
            onDeleteView={removeView}
            searchInput={searchInput}
            onSearchInputChange={setSearchInput}
            sort={state.sort}
            dir={state.dir}
            onSortChange={(sort) => setState((s) => ({ ...s, sort, offset: 0 }))}
            onDirChange={(dir) => setState((s) => ({ ...s, dir, offset: 0 }))}
            canSaveView={canSaveView}
            onSaveView={saveCurrentView}
            exportHref={exportHref}
            paymentStatus={state.paymentStatus}
            fulfillmentStatus={state.fulfillmentStatus}
            source={state.source}
            dateFrom={state.dateFrom}
            dateTo={state.dateTo}
            onFilterChange={updateFilter}
          />

          {bulkMounted && (
            <div ref={bulkBarRef} className="cd-bulkbar">
              <span className="cd-row-title">{selected.size} selected</span>
              <label className="flex items-center gap-2 cd-caption">
                <input
                  type="checkbox"
                  checked={notifyOnFulfill}
                  onChange={(e) => setNotifyOnFulfill(e.target.checked)}
                />
                Notify customers
              </label>
              <Btn small icon="truck" disabled={bulkBusy} onClick={bulkFulfill}>
                Fulfill
              </Btn>
              <Btn small icon="archive" disabled={bulkBusy} onClick={() => bulkArchive(!isArchivedView)}>
                {isArchivedView ? "Unarchive" : "Archive"}
              </Btn>
              <div className="flex items-center gap-2">
                <input
                  className="cd-input"
                  placeholder="Add tag"
                  aria-label="Tag to add"
                  value={bulkTagInput}
                  onChange={(e) => setBulkTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") bulkAddTag();
                  }}
                  style={{ width: 140 }}
                />
                <Btn small icon="tag" disabled={bulkBusy || !bulkTagInput.trim()} onClick={bulkAddTag}>
                  Add tag
                </Btn>
              </div>
            </div>
          )}

          <div ref={listRef}>
            <UnifiedOrdersList
              rows={displayRows}
              loading={ordersListLoading}
              isDefaultView={isDefaultView}
              onRefund={setRefundOrder}
              onOpen={(sourceId) => app.navigate("orders", sourceId)}
              selected={selected}
              onToggleRow={toggleRow}
              onToggleAll={toggleAll}
              allSelected={allSelected}
              anySelectable={selectableIds.length > 0}
            />
          </div>

          {ordersListPage && ordersListPage.totalCount > 0 && (
            <div className="cd-orders-pagination">
              <span ref={pageSummaryRef} className="cd-caption">
                Showing {ordersListPage.offset + 1}-
                {Math.min(ordersListPage.offset + ordersListPage.rows.length, ordersListPage.totalCount)} of{" "}
                {ordersListPage.totalCount.toLocaleString("en-US")}
              </span>
              <div className="flex items-center gap-2">
                <Btn
                  small
                  disabled={ordersListPage.offset === 0}
                  onClick={() =>
                    setState((s) => ({ ...s, offset: Math.max(0, s.offset - ordersListPage.limit) }))
                  }
                >
                  Prev
                </Btn>
                <Btn
                  small
                  disabled={ordersListPage.offset + ordersListPage.rows.length >= ordersListPage.totalCount}
                  onClick={() => setState((s) => ({ ...s, offset: s.offset + ordersListPage.limit }))}
                >
                  Next
                </Btn>
              </div>
            </div>
          )}
        </Card>
      ) : !page ? (
        <Card pad={false} className="cd-order-subtable">
          {loading ? (
            <TableSkeleton />
          ) : (
            <Placeholder
              icon="doc"
              title="Orders unavailable"
              sub="Could not load orders just now. Refresh to try again."
            />
          )}
        </Card>
      ) : sub === "labels" ? (
        <Card pad={false} className="cd-order-subtable">
          {page.shipCharges.length === 0 ? (
            <Placeholder
              icon="truck"
              title="No shipping charges yet"
              sub="Carrier-invoice lines from your ship-cost imports land here, matched to orders."
            />
          ) : (
            <Pan min={600}>
              <div className="cd-tablehd" style={{ gridTemplateColumns: "1fr 1.3fr 1.6fr 0.9fr 1.1fr" }}>
                <span>Order</span>
                <span>Carrier</span>
                <span>Tracking</span>
                <span style={{ textAlign: "right" }}>Cost</span>
                <span>Status</span>
              </div>
              {page.shipCharges.map((r, i) => (
                <div key={i} className="cd-trow cd-order-subrow" data-attention={r.matched ? "0" : "1"} style={{ gridTemplateColumns: "1fr 1.3fr 1.6fr 0.9fr 1.1fr" }}>
                  <div className="cd-row-title tabular-nums">{r.orderRef}</div>
                  <div className="truncate">{r.carrier ?? "—"}</div>
                  <div className="cd-caption tabular-nums truncate">{r.tracking ?? "—"}</div>
                  <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                    {money(r.costCents)}
                  </div>
                  <div>
                    <span
                      className="cd-badge"
                      style={{
                        color: r.matched ? "var(--text-2)" : "var(--live)",
                        background: r.matched ? "var(--gray-bg)" : "color-mix(in oklch, var(--live) 12%, transparent)",
                      }}
                    >
                      {r.matched ? "Matched" : "Unmatched"}
                    </span>
                  </div>
                </div>
              ))}
            </Pan>
          )}
        </Card>
      ) : sub === "drafts" ? (
        <Card pad={false} className="cd-order-subtable">
          {page.drafts.length === 0 ? (
            <Placeholder
              icon="doc"
              title="No open carts"
              sub="In-progress baskets that haven't reached checkout show up here."
            />
          ) : (
            <Pan min={600}>
              <div className="cd-tablehd" style={{ gridTemplateColumns: "1fr 1.5fr 1.2fr 0.9fr 1.4fr" }}>
                <span>Cart</span>
                <span>Customer</span>
                <span>Items</span>
                <span style={{ textAlign: "right" }}>Value</span>
                <span>Started</span>
              </div>
              {page.drafts.map((r) => (
                <div key={r.id} className="cd-trow cd-order-subrow" style={{ gridTemplateColumns: "1fr 1.5fr 1.2fr 0.9fr 1.4fr" }}>
                  <div className="cd-row-title tabular-nums">{r.ref}</div>
                  <div className="truncate">{r.buyerEmail ?? "Guest"}</div>
                  <div className="cd-caption">{r.itemCount} items</div>
                  <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                    {money(r.valueCents, r.currency)}
                  </div>
                  <div className="cd-caption">{timeAgo(r.createdAt)}</div>
                </div>
              ))}
            </Pan>
          )}
        </Card>
      ) : (
        <Card pad={false} className="cd-order-subtable">
          {page.abandoned.length === 0 ? (
            <Placeholder
              icon="clock"
              title="No abandoned checkouts"
              sub="Checkouts that stall for over an hour before payment show up here."
            />
          ) : (
            <Pan min={680}>
              <div className="cd-tablehd" style={{ gridTemplateColumns: "1fr 1.6fr 0.9fr 0.8fr 1.1fr auto" }}>
                <span>Checkout</span>
                <span>Customer</span>
                <span style={{ textAlign: "right" }}>Value</span>
                <span>Stage</span>
                <span>Started</span>
                <span />
              </div>
              {page.abandoned.map((r) => (
                <div key={r.id} className="cd-trow cd-order-subrow" data-attention={r.recoveryEmailSentAt ? "0" : "1"} style={{ gridTemplateColumns: "1fr 1.6fr 0.9fr 0.8fr 1.1fr auto" }}>
                  <div className="cd-row-title tabular-nums">{r.ref}</div>
                  <div className="truncate">{r.buyerEmail ?? "Guest"}</div>
                  <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                    {money(r.totalCents, r.currency)}
                  </div>
                  <div className="cd-caption">Payment</div>
                  <div className="cd-caption">{timeAgo(r.createdAt)}</div>
                  <div className="flex items-center" style={{ gap: 8, justifyContent: "flex-end" }}>
                    {r.recoveryEmailSentAt && (
                      <span className="cd-caption">Sent {timeAgo(r.recoveryEmailSentAt)}</span>
                    )}
                    <Btn
                      small
                      icon="mail"
                      disabled={recoverySending.has(r.id)}
                      onClick={() => sendRecovery(r.id)}
                    >
                      {recoverySending.has(r.id) ? "Sending…" : r.recoveryEmailSentAt ? "Resend" : "Send recovery email"}
                    </Btn>
                  </div>
                </div>
              ))}
            </Pan>
          )}
        </Card>
      )}
      </div>

      {refundOrder && (
        <RefundModal
          app={app}
          order={refundOrder}
          onClose={() => setRefundOrder(null)}
          onDone={() => loadOrdersList(effectiveParams, isDefaultView)}
        />
      )}
    </div>
  );
}
