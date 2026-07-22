import { useCallback, useEffect, useRef, useState } from "react";
import { Btn, Card } from "../ui";
import { CDIcon } from "../icons";
import {
  OrderListTable,
  OrderListToolbar,
  OrderPageReadout,
  OrderSortHeader,
  nextSortState,
  useSortedRowsEntrance,
  type OrderListView,
} from "./OrderListFamily";
import {
  DEFAULT_INVENTORY_SORT,
  parseInventorySort,
} from "~/lib/catalog/inventory-sort";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { timeAgo } from "../format";
import InventoryPanel from "./InventoryPanel";
import type { DashboardCtx } from "../context";
import { useModalChrome } from "../use-modal-chrome";

// Product / On hand / Reserved / Available / Status / Autopilot / row chevron — same rhythm as
// the Orders table, whose trailing cell carries the open-row affordance. Backed by the shop-wide
// inventory_list RPC (per-variant balance rollups), so reserved/available are real ledger
// numbers, not zero-fill.
const GRID = "2fr 0.7fr 0.7fr 0.7fr 1fr 1.1fr 36px";

type StockFilter = "all" | "low" | "out";

const STOCK_VIEWS: OrderListView[] = [
  { id: "all", label: "All" },
  { id: "low", label: "Low" },
  { id: "out", label: "Out" },
];

type InventoryPage = { rows: client.InventoryRowVM[]; total: number };

type StockStatus = { label: string; live: boolean };

/** Stock badge from real signals only: zero on hand is out of stock; "Low"
 * rides the per-location reorder-point flag the RPC rolls up. Needs-attention
 * states carry the live-blue badge (the Orders language) — the palette here is
 * black/gray/blue only. */
function stockStatus(r: client.InventoryRowVM): StockStatus {
  if (r.onHand <= 0) return { label: "Out of stock", live: true };
  if (r.low) return { label: "Low", live: true };
  return { label: "Healthy", live: false };
}

export default function Inventory({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache (default filter — the mount state) so a
  // return visit paints instantly; the load below revalidates per filter and
  // writes back through.
  const seeded = cachedScreenData<InventoryPage>(SCREEN_CACHE_KEYS.inventoryList);
  const [rows, setRows] = useState<client.InventoryRowVM[] | null>(() => seeded?.rows ?? null);
  const [total, setTotal] = useState(() => seeded?.total ?? 0);
  const [stock, setStock] = useState<StockFilter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(() => !seeded);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openRow, setOpenRow] = useState<client.InventoryRowVM | null>(null);
  const [savingQty, setSavingQty] = useState<string | null>(null);
  const [sortState, setSortState] = useState<{ sort: string; dir: "asc" | "desc" }>(
    DEFAULT_INVENTORY_SORT,
  );

  // Debounce the search box so each keystroke doesn't fire a request.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const stockParam = stock === "all" ? undefined : stock;

  // Ordering runs in the RPC, not here: the list is paged, so sorting the loaded
  // rows would answer "highest on hand" with "highest among the first page".
  // undefined means the default ordering, which no column represents.
  const sortParam = parseInventorySort(sortState.sort);

  // Latest filter identity, read after an async load to detect a filter change
  // that happened while the request was in flight. Updated every render. The
  // sort belongs in here too — it re-queries from offset 0, so a page that
  // lands from the previous ordering must not append to the new one.
  const filterToken = JSON.stringify([query, stock, sortState.sort, sortState.dir]);
  const filterRef = useRef(filterToken);
  filterRef.current = filterToken;

  // Only the default state (no search, "all" stock, default ordering) seeds and
  // writes the cache — any other view is live-fetch-only so it never poisons the
  // seeded default the screen paints from on return visits.
  const isDefault = !query && stock === "all" && !sortParam;

  // Shared by the filter-change effect and the drawer-close refresh, so both
  // paths run the exact same fetch + cache rules.
  const load = useCallback(
    (signal?: { alive: boolean }) => {
      const cached = isDefault
        ? cachedScreenData<InventoryPage>(SCREEN_CACHE_KEYS.inventoryList)
        : null;
      if (cached) {
        // Last-known rows for the default view paint immediately — no
        // skeleton; the fetch below silently revalidates them.
        setRows(cached.rows);
        setTotal(cached.total);
      }
      setLoading(!cached);
      setError(null);
      client
        .fetchInventoryList({
          search: query || undefined,
          stock: stockParam,
          sort: sortParam,
          dir: sortState.dir,
        })
        .then((r) => {
          if (isDefault) cacheScreenData(SCREEN_CACHE_KEYS.inventoryList, r);
          if (signal && !signal.alive) return;
          setRows(r.rows);
          setTotal(r.total);
        })
        .catch((err: unknown) => {
          if (signal && !signal.alive) return;
          setError(err instanceof DashboardApiError ? err.message : "Couldn't load inventory.");
        })
        .finally(() => {
          if (!signal || signal.alive) setLoading(false);
        });
    },
    [query, stockParam, isDefault, sortParam, sortState.dir],
  );

  useEffect(() => {
    const signal = { alive: true };
    load(signal);
    return () => {
      signal.alive = false;
    };
  }, [load]);

  const loadMore = async () => {
    const token = filterRef.current;
    const offset = rows?.length ?? 0;
    setLoadingMore(true);
    try {
      const r = await client.fetchInventoryList({
        search: query || undefined,
        stock: stockParam,
        offset,
        // Must match the ordering the loaded rows came back in — the offset is
        // only meaningful against the same sort.
        sort: sortParam,
        dir: sortState.dir,
      });
      // The merchant changed the filter mid-flight: discard this page so stale
      // rows from the old filter don't append to the new list.
      if (filterRef.current !== token) return;
      // De-dupe by variant id: a concurrent stock edit can shift a row across
      // the page boundary under any of the stock-derived orderings, so a
      // paged-in row may already be shown.
      setRows((cur) => {
        const base = cur ?? [];
        const seen = new Set(base.map((x) => x.variantId));
        return [...base, ...r.rows.filter((x) => !seen.has(x.variantId))];
      });
      setTotal(r.total);
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't load more stock.",
        "warn",
        "critical",
      );
    } finally {
      setLoadingMore(false);
    }
  };

  // Inline on-hand commit (single-location rows only): optimistic patch with a
  // rollback snapshot; the value-derived input key below remounts the field
  // with the fresh number on either outcome.
  const commitQty = async (row: client.InventoryRowVM, next: number) => {
    if (!row.singleLocationId || next === row.onHand) return;
    const snapshot = rows;
    const delta = next - row.onHand;
    setSavingQty(row.variantId);
    setRows(
      (cur) =>
        cur?.map((x) =>
          x.variantId === row.variantId
            ? { ...x, onHand: next, available: x.available + delta }
            : x,
        ) ?? cur,
    );
    try {
      await client.setOnHand(row.variantId, row.singleLocationId, next);
    } catch (err) {
      setRows(snapshot);
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't update stock.",
        "warn",
        "critical",
      );
    } finally {
      setSavingQty(null);
    }
  };

  // Closing the drawer re-runs the current load so edits made inside it
  // (transfers, reorder points, on-hand changes) reflect in the grid.
  const closeDrawer = useCallback(() => {
    setOpenRow(null);
    load();
  }, [load]);

  // Escape/autofocus/Tab-cycle, active only while the drawer is open. Bubble
  // phase (default): TransferModal can open on top of this drawer and its
  // own capture-phase Escape listener swallows the keypress before it
  // reaches here, so the two don't both close on the same Escape.
  const { ref: drawerRef, onKeyDown: onDrawerKeyDown } = useModalChrome<HTMLDivElement>({
    onClose: closeDrawer,
    enabled: Boolean(openRow),
  });

  const filtered = Boolean(query) || stock !== "all";
  const shown = rows ?? [];

  // Header click policy shared with the Orders/Customers/Products tables: a new
  // column sorts its natural way (Product A-Z, the numeric columns highest
  // first), the active column flips, and a third click returns to the list's
  // default lowest-stock-first ordering, which has no column of its own.
  const headerSort = {
    sort: sortState.sort,
    dir: sortState.dir,
    onSort: (col: string) =>
      setSortState((cur) => nextSortState(cur, col, DEFAULT_INVENTORY_SORT)),
  };

  // Staggered row rise on loads, filter switches and re-sorts, scoped to this
  // table. Search keystrokes are excluded (the debounced query is not a
  // dependency) so the list doesn't flicker while typing.
  const listRef = useRef<HTMLDivElement>(null);
  useSortedRowsEntrance(listRef, shown.map((r) => r.variantId).join("|"), [
    rows,
    stock,
    sortState,
  ]);

  // Same header anatomy as Orders: h1, then the stat readout strip. Stock
  // counts are page-scoped (like Orders' "Page value"/"Page alerts"). Kept
  // mounted with last-known values during a reload — unmounting it would shift
  // the whole card up and back down on every tab switch. Only the very first
  // paint (nothing loaded yet) renders without it.
  const readoutItems = shown.length === 0 && loading
    ? []
    : [
        { label: total === 1 ? "tracked variant" : "tracked variants", value: total.toLocaleString("en-US") },
        {
          label: "units on page",
          value: shown.reduce((sum, r) => sum + r.onHand, 0).toLocaleString("en-US"),
        },
        {
          label: "low or out on page",
          value: shown.filter((r) => r.low || r.onHand <= 0).length.toLocaleString("en-US"),
        },
      ];

  return (
    <div className="cd-screen cd-orders-screen" data-screen-label="Products">
      <header className="cd-screen-head cd-order-page-head">
        <div>
          <h1 className="cd-h1">Products</h1>
        </div>
      </header>

      <OrderPageReadout items={readoutItems} ariaLabel="Inventory overview" />

      <div className="cd-order-section-panel">
      <Card pad={false} className="cd-order-workspace">
        <OrderListToolbar
          views={STOCK_VIEWS}
          view={stock}
          onViewChange={(v) => setStock(v as StockFilter)}
          searchValue={search}
          searchPlaceholder="Search by product, variant, or SKU"
          searchAriaLabel="Search inventory"
          onSearchChange={setSearch}
          filterLabel="Stock"
        />

        <div ref={listRef}>
        <OrderListTable
          loading={loading}
          error={error}
          empty={shown.length === 0}
          filtered={filtered}
          minWidth={680}
          columns={GRID}
          emptyIcon="box"
          emptyTitle="No tracked variants"
          emptySub="Add products with tracked inventory and their stock will appear here."
          filteredTitle="No matching stock"
          filteredSub="Try a different search or stock filter."
          headers={
            <>
              <OrderSortHeader label="Product" col="product" {...headerSort} />
              <OrderSortHeader label="On hand" col="on_hand" {...headerSort} />
              <OrderSortHeader label="Reserved" col="reserved" {...headerSort} />
              <OrderSortHeader label="Available" col="available" {...headerSort} />
              <OrderSortHeader label="Status" col="status" {...headerSort} />
              {/* Autopilot carries the restock-draft badge, which is attached to
                  the rows after the page query rather than being a column the
                  RPC can order by — so it stays a plain header. */}
              <span>Autopilot</span>
              <span />
            </>
          }
        >
          {shown.map((r) => {
              const st = stockStatus(r);
              const inlineEditable = r.locationCount === 1 && r.singleLocationId;
              return (
                // A div with button semantics rather than a real <button>: the
                // row nests the on-hand input and the restock badge button,
                // which are invalid inside <button>.
                <div
                  key={r.variantId}
                  role="button"
                  tabIndex={0}
                  className="cd-trow cd-order-row"
                  onClick={() => setOpenRow(r)}
                  onKeyDown={(e) => {
                    // Only when the row itself is focused — Enter inside the
                    // qty input must commit the edit, not open the drawer.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenRow(r);
                    }
                  }}
                  style={{ gridTemplateColumns: GRID, cursor: "pointer" }}
                >
                  <div className="cd-order-ref-cell">
                    <span className="cd-row-title truncate">{r.productTitle}</span>
                    <span className="cd-order-source-label truncate">
                      {[r.sku, r.variantTitle].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </div>
                  <div>
                    {inlineEditable ? (
                      <input
                        // Value-derived key so the input REMOUNTS (re-reading
                        // defaultValue) whenever the server on-hand changes,
                        // instead of keeping a stale uncontrolled value.
                        key={`oh:${r.variantId}:${r.onHand}`}
                        className="cd-input tabular-nums"
                        type="number"
                        min={0}
                        defaultValue={r.onHand}
                        disabled={savingQty === r.variantId}
                        aria-label={`On hand for ${r.sku ?? r.productTitle}`}
                        style={{ width: 72, height: 24, padding: "0 8px" }}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                        }}
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const parsed = Number(raw);
                          // An empty or unparseable field never commits — ''
                          // coerces to 0 and would zero out real stock. Restore
                          // the current value instead.
                          if (raw === "" || !Number.isFinite(parsed)) {
                            e.target.value = String(r.onHand);
                            return;
                          }
                          const next = Math.max(0, Math.trunc(parsed));
                          if (next !== r.onHand) void commitQty(r, next);
                        }}
                      />
                    ) : (
                      <div className="cd-order-ref-cell">
                        <span
                          className="cd-row-num tabular-nums"
                          style={r.onHand <= 0 ? { color: "var(--live)" } : undefined}
                        >
                          {r.onHand}
                        </span>
                        <span className="cd-order-source-label">{r.locationCount} loc</span>
                      </div>
                    )}
                  </div>
                  <div className="cd-row-num tabular-nums">{r.reserved}</div>
                  <div
                    className="cd-row-num tabular-nums"
                    style={r.available <= 0 ? { color: "var(--live)" } : undefined}
                  >
                    {r.available}
                  </div>
                  <div>
                    <span className={`cd-badge${st.live ? " cd-order-badge-live" : ""}`}>
                      {st.label}
                    </span>
                  </div>
                  <div>
                    {r.restock && (r.low || r.onHand <= 0) ? (
                      <button
                        type="button"
                        className="cd-badge"
                        onClick={(e) => {
                          e.stopPropagation();
                          app.navigate("products-po");
                        }}
                        style={{
                          background: "var(--accent-bg)",
                          color: "var(--accent)",
                          border: 0,
                          cursor: "pointer",
                        }}
                      >
                        <CDIcon name="doc" size={12} />
                        Restock draft · {timeAgo(r.restock.createdAt)}
                      </button>
                    ) : null}
                  </div>
                  <div className="cd-order-row-actions">
                    <CDIcon name="chevronRight" size={15} className="cd-order-row-chevron" />
                  </div>
                </div>
              );
            })}
        </OrderListTable>
        </div>
      </Card>

      {!loading && !error && rows && rows.length < total && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <Btn disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Loading…" : `Load more (${rows.length} of ${total})`}
          </Btn>
        </div>
      )}
      </div>

      {openRow && (
        <div
          role="presentation"
          onClick={closeDrawer}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "color-mix(in oklch, black 32%, transparent)",
          }}
        >
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Stock details"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onDrawerKeyDown}
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              bottom: 0,
              width: "min(560px, 100vw)",
              overflowY: "auto",
              padding: 16,
            }}
          >
            <Card>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <div className="min-w-0">
                  <div className="cd-h2 truncate">{openRow.productTitle}</div>
                  <div className="cd-caption truncate">
                    {[openRow.sku, openRow.variantTitle].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={closeDrawer}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 26,
                    height: 26,
                    background: "none",
                    border: 0,
                    color: "inherit",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <CDIcon name="x" size={15} />
                </button>
              </div>
              <InventoryPanel app={app} variantId={openRow.variantId} />
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
                <Btn small icon="external" onClick={() => app.navigate("product-editor", openRow.productId)}>
                  Open product
                </Btn>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
