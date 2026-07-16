import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Btn, Card } from "../ui";
import { money, timeAgo } from "../format";
import { reduced } from "../hero/hero-motion";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  bulkAddOrderTags,
  bulkArchiveOrders,
  bulkFulfillOrders,
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
import {
  cacheScreenData,
  cachedScreenData,
  SCREEN_CACHE_KEYS,
} from "~/lib/dashboard/screen-cache";
import type { DashboardCtx } from "../context";
import RefundModal from "./RefundModal";
import OrderDetailScreen from "./OrderDetail";
import OrderComposer from "./OrderComposer";
import OrdersToolbar from "./OrdersToolbar";
import OrderSubLists, { type OrderSubSection } from "./OrderSubLists";
import {
  OrderBulkBar,
  OrderListPagination,
  OrderListTable,
  OrderSortHeader,
  nextSortState,
} from "./OrderListFamily";
import { CDIcon } from "../icons";
import {
  fulfillmentBadge,
  isStuckUnfulfilled,
  paymentPillStyle,
  REFUNDABLE_ORDER_STATES,
  stuckDays,
} from "./order-status";
import { isPrefillParam } from "./order-composer-prefill";
import {
  isSystemView,
  stateToParams,
  viewFiltersToParams,
  type ListFilterPatch,
  type ListState,
} from "./orders-list-state";

const ORDER_SECTION_META: Record<string, { title: string; sub: string }> = {
  orders: {
    title: "Orders",
    sub: "Storefront and Shopify orders, in one place.",
  },
  labels: {
    title: "Shipping charges",
    sub: "Shipping costs matched to their orders.",
  },
  drafts: { title: "Draft carts", sub: "Customer carts still in progress." },
  abandoned: {
    title: "Abandoned checkouts",
    sub: "Checkouts ready for recovery.",
  },
};

const ORDER_TABLE_COLUMNS =
  "36px 112px minmax(190px, 1.5fr) 96px 88px 112px 132px 88px";

// The server's default ordering when the list request carries no explicit sort/dir. Header
// clicks that land back on this exact ordering normalize to undefined (see sortByColumn) so the
// default view keeps its screen-cache write-through.
const DEFAULT_ORDER_SORT = { sort: "date", dir: "desc" } as const;

function PaymentPill({ status }: { status: string }) {
  const s = paymentPillStyle(status);
  const active = status === "paid" || status === "authorized";
  return (
    <span className={`cd-badge${active ? " cd-order-badge-live" : ""}`}>
      {s.label}
    </span>
  );
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
  error,
  sort,
  dir,
  onSort,
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
  error: string | null;
  sort: OrdersListParams["sort"];
  dir: OrdersListParams["dir"];
  onSort: (col: string) => void;
}) {
  const resolvedRows = rows ?? [];
  const cols = ORDER_TABLE_COLUMNS;
  // sort/dir undefined means the server default — resolve once so the header arrows always
  // reflect the ordering actually in effect.
  const effSort = sort ?? DEFAULT_ORDER_SORT.sort;
  const effDir = dir ?? DEFAULT_ORDER_SORT.dir;
  const sortHd = (label: string, col: string, align?: "right") => (
    <OrderSortHeader
      label={label}
      col={col}
      sort={effSort}
      dir={effDir}
      onSort={onSort}
      align={align}
    />
  );
  return (
    <OrderListTable
      loading={loading}
      error={error}
      empty={resolvedRows.length === 0}
      filtered={!isDefaultView}
      minWidth={880}
      columns={cols}
      emptyIcon="doc"
      emptyTitle="No orders yet"
      filteredTitle="No orders match this view"
      headers={
        <>
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
          {sortHd("Customer", "customer")}
          {sortHd("Total", "total", "right")}
          {sortHd("Date", "date")}
          <span>Payment</span>
          <span>Fulfillment</span>
          <span />
        </>
      }
    >
      {resolvedRows.map((r) => {
        const refundable =
          r.refundRow && REFUNDABLE_ORDER_STATES.has(r.state)
            ? r.refundRow
            : null;
        const fulfillment =
          r.source === "calderyn"
            ? fulfillmentBadge(r.state, r.cancelledAt)
            : null;
        // Stuck-unfulfilled badge: native orders only, paid > 3 days with nothing shipped.
        const now = Date.now();
        const stuck =
          r.source === "calderyn" && r.createdAt
            ? isStuckUnfulfilled(r.state, r.createdAt, now)
            : false;
        const stuckN =
          stuck && r.createdAt ? stuckDays(r.createdAt, now) : null;
        const open = () => onOpen(displayOrderSourceId(r));
        const selectableId = r.source === "calderyn" ? r.id : null;
        return (
          <div
            key={`${r.source}:${r.id}`}
            className="cd-trow cd-order-row"
            data-selected={
              selectableId && selected.has(selectableId) ? "1" : "0"
            }
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
              <span className="cd-row-title tabular-nums truncate">
                {r.ref}
              </span>
              {r.source === "shopify" && (
                <span className="cd-order-source-label">Shopify</span>
              )}
            </div>
            <div className="truncate">
              {r.customer ?? (r.source === "shopify" ? "" : "Guest")}
            </div>
            <div
              className="cd-row-num tabular-nums"
              style={{ textAlign: "right" }}
            >
              {money(r.totalCents, r.currency)}
            </div>
            <div className="cd-caption">
              {r.createdAt ? timeAgo(r.createdAt) : ""}
            </div>
            <div>
              <PaymentPill status={r.financialStatus} />
            </div>
            <div
              className="flex items-center"
              style={{ gap: 6, flexWrap: "wrap" }}
            >
              {fulfillment && (
                <span
                  className={`cd-badge${stuckN != null ? " cd-order-badge-live" : ""}`}
                >
                  {fulfillment.label}
                  {stuckN != null ? ` · ${stuckN}d` : ""}
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
                <CDIcon
                  name="chevronRight"
                  size={15}
                  className="cd-order-row-chevron"
                />
              )}
            </div>
          </div>
        );
      })}
    </OrderListTable>
  );
}

export default function Orders({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints the last page
  // instantly; the mount fetch below revalidates and writes back through.
  const [page, setPage] = useState<OrdersPage | null>(() =>
    cachedScreenData<OrdersPage>(SCREEN_CACHE_KEYS.orders),
  );
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [refundOrder, setRefundOrder] = useState<OrderRow | null>(null);
  const toast = app.toast;

  const load = useCallback(
    (signal?: { alive: boolean }) => {
      setLoading(true);
      setPageError(null);
      fetchOrdersPage()
        .then((p) => {
          cacheScreenData(SCREEN_CACHE_KEYS.orders, p);
          if (!signal || signal.alive) setPage(p);
        })
        .catch((err: unknown) => {
          if (signal && !signal.alive) return;
          const msg =
            err instanceof DashboardApiError
              ? err.message
              : "Could not load orders.";
          setPageError(msg);
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
  const [ordersListPage, setOrdersListPage] =
    useState<UnifiedOrdersPage | null>(() =>
      cachedScreenData<UnifiedOrdersPage>(SCREEN_CACHE_KEYS.ordersList),
    );
  const [ordersListLoading, setOrdersListLoading] = useState(true);
  const [ordersListError, setOrdersListError] = useState<string | null>(null);

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

  // Whether any of the manually-picked toolbar filter controls carry a value — widens
  // isDefaultView below so a filtered page never writes through the screen cache.
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

  const loadOrdersList = useCallback(
    (
      params: OrdersListParams,
      isDefault: boolean,
      signal?: { alive: boolean },
    ) => {
      setOrdersListLoading(true);
      setOrdersListError(null);
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
            setState((s) => ({
              ...s,
              offset: Math.max(0, p.offset - p.limit),
            }));
          }
        })
        .catch((err: unknown) => {
          if (signal && !signal.alive) return;
          const msg =
            err instanceof DashboardApiError
              ? err.message
              : "Could not load orders.";
          setOrdersListError(msg);
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
  const listParamsRef = useRef({
    params: effectiveParams,
    isDefault: isDefaultView,
  });
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

  // Header-driven sorting via the shared nextSortState policy (OrderListFamily.tsx). A result
  // equal to the server default normalizes back to undefined so the bare default view keeps its
  // screen-cache write-through (isDefaultView checks sort/dir === undefined) and default fetches
  // keep the bare param shape.
  const sortByColumn = useCallback((col: string) => {
    setState((s) => {
      const next = nextSortState(
        { sort: s.sort ?? DEFAULT_ORDER_SORT.sort, dir: s.dir ?? DEFAULT_ORDER_SORT.dir },
        col,
        DEFAULT_ORDER_SORT,
      );
      const isDefault =
        next.sort === DEFAULT_ORDER_SORT.sort && next.dir === DEFAULT_ORDER_SORT.dir;
      return {
        ...s,
        sort: isDefault ? undefined : (next.sort as NonNullable<OrdersListParams["sort"]>),
        dir: isDefault ? undefined : next.dir,
        offset: 0,
      };
    });
  }, []);

  const removeView = useCallback(
    async (id: string) => {
      try {
        await deleteOrderView(id);
        setSavedViews((vs) => vs.filter((v) => v.id !== id));
        setState((s) => (s.view === id ? { ...s, view: "all", offset: 0 } : s));
        toast("View deleted.", "check", "success");
      } catch (err) {
        toast(
          err instanceof DashboardApiError
            ? err.message
            : "Couldn't delete this view.",
          "warn",
          "critical",
        );
      }
    },
    [toast],
  );

  const exportHref = useMemo(() => {
    const qs = ordersListParamsToQueryString({
      ...effectiveParams,
      offset: undefined,
      limit: undefined,
    });
    return `/dashboard/api/orders/export${qs ? `?${qs}` : ""}`;
  }, [effectiveParams]);

  const displayRows = useMemo(
    () =>
      ordersListPage ? ordersListPage.rows.map(unifiedRowToDisplayOrder) : null,
    [ordersListPage],
  );

  // Subtle staggered rise on every fresh page of rows — initial load, a tab switch, a filter
  // change, paging. Keyed on the page object itself (a new reference every fetch), scoped to just
  // this table so it can never pick up a `.cd-trow` from an unrelated screen.
  const listRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (
        reduced() ||
        !displayRows ||
        displayRows.length === 0 ||
        !listRef.current
      )
        return;
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

  const selectableIds = useMemo(
    () =>
      (displayRows ?? [])
        .filter((r) => r.source === "calderyn")
        .map((r) => r.id),
    [displayRows],
  );
  const refById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of displayRows ?? [])
      if (r.source === "calderyn") m.set(r.id, r.ref);
    return m;
  }, [displayRows]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set());
  }, [ordersListPage]);

  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

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
      const allOn =
        selectableIds.length > 0 && selectableIds.every((id) => prev.has(id));
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
      toast(
        `${ok.length} of ${results.length} ${verb}. ${failed.length} failed.`,
        "warn",
        "critical",
      );
      if (failed.length <= 3) {
        const refs = failed
          .map((f) => refById.get(f.orderId) ?? f.orderId)
          .join(", ");
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
      const { results } = await bulkFulfillOrders(
        ids,
        notifyOnFulfill,
        crypto.randomUUID(),
      );
      summarizeBulk(results, "fulfilled");
      loadOrdersList(effectiveParams, isDefaultView);
    } catch (err) {
      toast(
        err instanceof DashboardApiError
          ? err.message
          : "Couldn't fulfill these orders.",
        "warn",
        "critical",
      );
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
      toast(
        err instanceof DashboardApiError
          ? err.message
          : "Couldn't update these orders.",
        "warn",
        "critical",
      );
    } finally {
      setBulkBusy(false);
    }
  };

  // Abandoned tab: manual recovery-email resend. Honest, reason-specific toasts (rather than a
  // generic failure) when sendOrderRecoveryEmail resolves {sent:false, reason} — the same
  // eligibility checks the automatic sweep applies (recovery.server.ts), surfaced plainly rather
  // than as an opaque error.
  const [recoverySending, setRecoverySending] = useState<Set<string>>(
    new Set(),
  );
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
                  r.id === orderId
                    ? { ...r, recoveryEmailSentAt: new Date().toISOString() }
                    : r,
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
      toast(
        err instanceof DashboardApiError
          ? err.message
          : "Couldn't send the recovery email.",
        "warn",
        "critical",
      );
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
      toast(
        err instanceof DashboardApiError
          ? err.message
          : "Couldn't tag these orders.",
        "warn",
        "critical",
      );
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
      loadOrdersList(
        listParamsRef.current.params,
        listParamsRef.current.isDefault,
      );
    }
  }, [app.nav.param, load, loadOrdersList]);

  const sub = app.nav.sub ?? "orders";
  const sectionMeta = ORDER_SECTION_META[sub] ?? ORDER_SECTION_META.orders;
  const overviewItems = useMemo<
    Array<{ label: string; value: string; action?: () => void }>
  >(() => {
    if (sub === "orders") {
      if (!displayRows && !ordersListPage) return [];
      const rows = displayRows ?? [];
      const now = Date.now();
      const attention = rows.filter(
        (row) =>
          row.financialStatus === "pending" ||
          (row.source === "calderyn" &&
            row.createdAt &&
            isStuckUnfulfilled(row.state, row.createdAt, now)),
      ).length;
      return [
        {
          label: "Orders",
          value: (ordersListPage?.totalCount ?? rows.length).toLocaleString(
            "en-US",
          ),
        },
        {
          label: "Page value",
          value: money(
            rows.reduce((sum, row) => sum + row.totalCents, 0),
            rows[0]?.currency ?? "usd",
          ),
        },
        {
          label: "Page alerts",
          value: attention.toLocaleString("en-US"),
        },
      ];
    }
    if (!page) return [];
    if (sub === "labels") {
      return [
        {
          label: "Charges",
          value: page.shipCharges.length.toLocaleString("en-US"),
        },
        {
          label: "Recorded cost",
          value: money(
            page.shipCharges.reduce((sum, row) => sum + row.costCents, 0),
          ),
        },
        {
          label: "Unmatched",
          value: page.shipCharges
            .filter((row) => !row.matched)
            .length.toLocaleString("en-US"),
        },
      ];
    }
    if (sub === "drafts") {
      return [
        { label: "Carts", value: page.drafts.length.toLocaleString("en-US") },
        {
          label: "Cart value",
          value: money(
            page.drafts.reduce((sum, row) => sum + row.valueCents, 0),
            page.drafts[0]?.currency ?? "usd",
          ),
        },
        {
          label: "Identified",
          value: page.drafts
            .filter((row) => row.buyerEmail)
            .length.toLocaleString("en-US"),
        },
      ];
    }
    return [
      {
        label: "Checkouts",
        value: page.abandoned.length.toLocaleString("en-US"),
      },
      {
        label: "Potential value",
        value: money(
          page.abandoned.reduce((sum, row) => sum + row.totalCents, 0),
          page.abandoned[0]?.currency ?? "usd",
        ),
      },
      {
        label: "Unsent",
        value: page.abandoned
          .filter((row) => !row.recoveryEmailSentAt)
          .length.toLocaleString("en-US"),
      },
    ];
  }, [displayRows, ordersListPage, page, sub]);

  const overviewRef = useRef<HTMLDivElement>(null);
  const overviewKey = overviewItems
    .map((item) => `${item.label}:${item.value}`)
    .join("|");
  const sectionPanelRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (reduced() || !overviewRef.current) return;
      const items = overviewRef.current.querySelectorAll<HTMLElement>(
        ".cd-order-readout-item",
      );
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
  if (
    app.nav.param === "new" ||
    (app.nav.param && isPrefillParam(app.nav.param))
  ) {
    return (
      <OrderComposer
        app={app}
        prefillParam={app.nav.param === "new" ? null : app.nav.param}
      />
    );
  }

  // Row-click / deep-link: nav.param carries the selected order's sourceId (`shopify:<id>` for
  // migrated orders, a bare id for native ones) — same idiom as Campaigns' selected-campaign branch.
  if (app.nav.param) {
    const seedRow =
      (displayRows ?? []).find(
        (r) => displayOrderSourceId(r) === app.nav.param,
      ) ?? null;
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
    <div
      className="cd-screen cd-orders-screen"
      data-screen-label="Orders"
      data-sub={sub}
    >
      <header className="cd-screen-head cd-order-page-head">
        <div>
          <h1 className="cd-h1">{sectionMeta.title}</h1>
          {sub === "orders" && <p className="cd-sub">{sectionMeta.sub}</p>}
        </div>
        {(sub === "orders" || sub === "drafts") && (
          <Btn
            kind="primary"
            small
            onClick={() => app.navigate("orders", "new")}
          >
            Create order
          </Btn>
        )}
      </header>

      {overviewItems.length > 0 && (
        <div
          ref={overviewRef}
          className="cd-order-readout"
          aria-label={`${sectionMeta.title} overview`}
        >
          {overviewItems.map((item) => {
            const content = (
              <>
                <strong className="tabular-nums">{item.value}</strong>
                <span>{item.label}</span>
                {item.action && (
                  <CDIcon name="arrowRight" size={14} strokeWidth={1.9} />
                )}
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
              exportHref={exportHref}
              paymentStatus={state.paymentStatus}
              fulfillmentStatus={state.fulfillmentStatus}
              source={state.source}
              dateFrom={state.dateFrom}
              dateTo={state.dateTo}
              onFilterChange={updateFilter}
            />

            <OrderBulkBar count={selected.size}>
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
              <Btn
                small
                icon="archive"
                disabled={bulkBusy}
                onClick={() => bulkArchive(!isArchivedView)}
              >
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
                <Btn
                  small
                  icon="tag"
                  disabled={bulkBusy || !bulkTagInput.trim()}
                  onClick={bulkAddTag}
                >
                  Add tag
                </Btn>
              </div>
            </OrderBulkBar>

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
                error={ordersListError}
                sort={state.sort}
                dir={state.dir}
                onSort={sortByColumn}
              />
            </div>

            {ordersListPage && ordersListPage.totalCount > 0 && (
              <OrderListPagination
                start={ordersListPage.offset + 1}
                end={Math.min(
                  ordersListPage.offset + ordersListPage.rows.length,
                  ordersListPage.totalCount,
                )}
                total={ordersListPage.totalCount}
                onPrevious={() =>
                  setState((s) => ({
                    ...s,
                    offset: Math.max(0, s.offset - ordersListPage.limit),
                  }))
                }
                onNext={() =>
                  setState((s) => ({
                    ...s,
                    offset: s.offset + ordersListPage.limit,
                  }))
                }
              />
            )}
          </Card>
        ) : (
          <OrderSubLists
            section={sub as OrderSubSection}
            page={page}
            loading={loading}
            error={pageError}
            recoverySending={recoverySending}
            onSendRecovery={sendRecovery}
          />
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
