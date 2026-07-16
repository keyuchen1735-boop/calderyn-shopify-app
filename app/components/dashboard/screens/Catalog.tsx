import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, catalogCacheKey } from "~/lib/dashboard/screen-cache";
import { Card, Btn } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import type { CatalogSort } from "~/lib/catalog/catalog-sort";
import {
  OrderBulkBar,
  OrderListTable,
  OrderListToolbar,
  OrderPageReadout,
  OrderSortHeader,
  nextSortState,
  type OrderListView,
} from "./OrderListFamily";
import { localDayEndIso, localDayStartIso } from "./orders-list-state";

type StatusFilter = "All" | "active" | "draft" | "archived";

const STATUS_VIEWS: OrderListView[] = [
  { id: "All", label: "All" },
  { id: "active", label: "Active" },
  { id: "draft", label: "Draft" },
  { id: "archived", label: "Archived" },
];

// checkbox / thumbnail / Product / Price / Status / Ship data / row chevron — same rhythm as the
// Orders table, whose trailing cell carries the open-row affordance.
const GRID = "36px 36px minmax(190px, 2fr) 1fr 1fr 1fr 36px";

// The catalog list's default ordering (the server's "updated" sort). Header clicks cycle through
// title A-Z / Z-A and back to this via nextSortState, same policy as the Orders tables.
const DEFAULT_CATALOG_SORT = { sort: "updated", dir: "desc" } as const;

/** CatalogSort wire value <-> the {sort, dir} shape the shared header-sort policy speaks. */
function catalogSortToHeaderState(sort: CatalogSort): { sort: string; dir: "asc" | "desc" } {
  if (sort === "title_asc") return { sort: "title", dir: "asc" };
  if (sort === "title_desc") return { sort: "title", dir: "desc" };
  if (sort === "status_asc") return { sort: "status", dir: "asc" };
  if (sort === "status_desc") return { sort: "status", dir: "desc" };
  return DEFAULT_CATALOG_SORT;
}

function headerStateToCatalogSort(state: { sort: string; dir: "asc" | "desc" }): CatalogSort {
  if (state.sort === "title") return state.dir === "asc" ? "title_asc" : "title_desc";
  if (state.sort === "status") return state.dir === "asc" ? "status_asc" : "status_desc";
  return "updated";
}

/** ISO datetime -> the bare "YYYY-MM-DD" an <input type="date"> can display. */
function isoToDateInputValue(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

/** Ship-data cell copy — "Validated · <weight>kg" only when the product truly
 * passes the activation shipping check; the weight is the heaviest recorded
 * physical variant. No weight recorded (all-digital) drops the suffix. */
function shipLabel(p: client.ProductSummaryVM): string {
  if (!p.shipDataOk) return "Missing dims";
  if (p.shipWeightGrams == null) return "Validated";
  const kg = (p.shipWeightGrams / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `Validated · ${kg}kg`;
}

type CatalogPage = { products: client.ProductSummaryVM[]; total: number };

export default function Catalog({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache (default filter — the mount state) so a
  // return visit paints the last list instantly; the effect below revalidates
  // per filter and writes back through.
  const seeded = cachedScreenData<CatalogPage>(catalogCacheKey("", undefined));
  const [products, setProducts] = useState<client.ProductSummaryVM[]>(() => seeded?.products ?? []);
  const [total, setTotal] = useState(() => seeded?.total ?? 0);
  const [status, setStatus] = useState<StatusFilter>("All");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<CatalogSort>("updated");
  // Filters popover state: an inclusive last-updated date range.
  const [updatedFrom, setUpdatedFrom] = useState<string | undefined>(undefined);
  const [updatedTo, setUpdatedTo] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(() => !seeded);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Debounce the search box so each keystroke doesn't fire a request.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const statusParam = status === "All" ? undefined : status;
  const hasDateFilter = Boolean(updatedFrom || updatedTo);

  // Latest filter identity, read after an async load to detect a filter change
  // that happened while the request was in flight (a closure-captured copy can't,
  // since it would equal itself). Updated every render.
  const filterToken = JSON.stringify([query, statusParam ?? "", sort, updatedFrom ?? "", updatedTo ?? ""]);
  const filterRef = useRef(filterToken);
  filterRef.current = filterToken;

  // Shared by the filter-change effect below and the post-bulk-action refresh,
  // so both paths run the exact same fetch + cache rules.
  const load = useCallback(
    (signal?: { alive: boolean }) => {
      // Only the default sort with no date filter seeds/writes the cache — any
      // other combination is live-fetch-only so it never poisons the seeded view.
      const key = catalogCacheKey(query, statusParam);
      const cacheable = sort === "updated" && !hasDateFilter;
      const cached = cacheable ? cachedScreenData<CatalogPage>(key) : undefined;
      if (cached) {
        // Last-known rows for this filter paint immediately — no skeleton, no
        // "Loading…" caption; the fetch below silently revalidates them.
        setProducts(cached.products);
        setTotal(cached.total);
      }
      setLoading(!cached);
      setError(null);
      client
        .fetchProducts({ search: query || undefined, status: statusParam, sort, updatedFrom, updatedTo })
        .then((r) => {
          if (cacheable) cacheScreenData(key, { products: r.products, total: r.total });
          if (signal && !signal.alive) return;
          setProducts(r.products);
          setTotal(r.total);
        })
        .catch((err: unknown) => {
          if (signal && !signal.alive) return;
          setError(err instanceof DashboardApiError ? err.message : "Couldn't load products.");
        })
        .finally(() => {
          if (!signal || signal.alive) setLoading(false);
        });
    },
    [query, statusParam, sort, updatedFrom, updatedTo, hasDateFilter],
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
    setLoadingMore(true);
    try {
      const r = await client.fetchProducts({
        search: query || undefined,
        status: statusParam,
        sort,
        updatedFrom,
        updatedTo,
        offset: products.length,
      });
      // The merchant changed the filter mid-flight: discard this page so stale
      // rows from the old filter don't append to the new list.
      if (filterRef.current !== token) return;
      // De-dupe by id: the list is ordered by updated_at, which a concurrent edit
      // can shift, so a paged-in row may already be shown (avoids duplicate keys).
      setProducts((cur) => {
        const seen = new Set(cur.map((p) => p.id));
        return [...cur, ...r.products.filter((p) => !seen.has(p.id))];
      });
      setTotal(r.total);
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't load more products.", "warn", "critical");
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = Boolean(query) || status !== "All" || hasDateFilter;

  // --- bulk selection ---------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Key the reset on the id COMPOSITION, not the array identity: a background
  // revalidation of the seeded cache lands a new array of the same rows, and
  // clearing on it would wipe an in-progress selection mid-click. A real
  // page/filter change still changes the ids and clears.
  const idsKey = useMemo(() => products.map((p) => p.id).join("|"), [products]);
  useEffect(() => {
    setSelected(new Set());
  }, [idsKey]);

  const allSelected = products.length > 0 && products.every((p) => selected.has(p.id));

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
      const allOn = products.length > 0 && products.every((p) => prev.has(p.id));
      return new Set(allOn ? [] : products.map((p) => p.id));
    });
  }, [products]);

  const [bulkBusy, setBulkBusy] = useState(false);
  const [collections, setCollections] = useState<client.CollectionVM[] | null>(null);
  const [collectionId, setCollectionId] = useState("");

  // Collections load lazily on the FIRST selection — the bulk bar's picker is the
  // only consumer, so an idle Catalog visit never pays for the extra request. A
  // failed fetch resets the flag so the next selection change retries.
  const collectionsRequested = useRef(false);
  useEffect(() => {
    if (selected.size === 0 || collectionsRequested.current) return;
    collectionsRequested.current = true;
    client
      .fetchCollections()
      .then(setCollections)
      .catch((err: unknown) => {
        collectionsRequested.current = false;
        app.toast(
          err instanceof DashboardApiError ? err.message : "Couldn't load collections.",
          "warn",
          "critical",
        );
      });
  }, [selected, app]);

  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products) m.set(p.id, p.title);
    return m;
  }, [products]);

  const summarizeBulk = useCallback(
    (results: client.BulkProductResultVM[], verb: string) => {
      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        app.toast(`${ok.length} ${verb}.`, "check", "success");
        return;
      }
      app.toast(`${ok.length} of ${results.length} ${verb}. ${failed.length} failed.`, "warn", "critical");
      if (failed.length <= 3) {
        const titles = failed.map((f) => titleById.get(f.productId) ?? f.productId).join(", ");
        app.toast(`Failed: ${titles}`, "warn", "critical");
      } else {
        app.toast("Check the products.", "warn", "critical");
      }
    },
    [titleById, app],
  );

  const bulkStatus = async (
    nextStatus: "active" | "draft" | "archived",
    verb: string,
    confirmMessage?: string,
  ) => {
    const ids = Array.from(selected);
    if (ids.length === 0 || bulkBusy) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setBulkBusy(true);
    try {
      const { results } = await client.bulkSetProductStatus(ids, nextStatus);
      summarizeBulk(results, verb);
      setSelected(new Set());
      load();
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't update these products.",
        "warn",
        "critical",
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkAddToCollection = async () => {
    const ids = Array.from(selected);
    if (!collectionId || ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const { results } = await client.bulkAddProductsToCollection(ids, collectionId);
      summarizeBulk(results, "added to collection");
      setSelected(new Set());
      load();
    } catch (err) {
      app.toast(
        err instanceof DashboardApiError ? err.message : "Couldn't add these products.",
        "warn",
        "critical",
      );
    } finally {
      setBulkBusy(false);
    }
  };

  // The archived tab flips the archive button into a way back out; everywhere
  // else it archives (with a confirm — it removes products from the storefront).
  const isArchivedView = status === "archived";

  // Header-driven sorting via the shared nextSortState policy: Title A-Z, then Z-A, then back to
  // the default recently-updated ordering (which has no column of its own).
  const sortByColumn = useCallback((col: string) => {
    setSort((cur) =>
      headerStateToCatalogSort(nextSortState(catalogSortToHeaderState(cur), col, DEFAULT_CATALOG_SORT)),
    );
  }, []);
  const headerSort = catalogSortToHeaderState(sort);

  // Same header anatomy as Orders: h1, then the stat readout strip. The gap
  // counts are page-scoped (like Orders' "Page value"/"Page alerts"). Kept
  // mounted with last-known values during a reload — unmounting it would shift
  // the whole card up and back down on every tab switch. Only the very first
  // paint (nothing loaded yet) renders without it.
  const readoutItems = products.length === 0 && loading
    ? []
    : [
        { label: total === 1 ? "product" : "products", value: total.toLocaleString("en-US") },
        {
          label: "active on page",
          value: products.filter((p) => p.status === "active").length.toLocaleString("en-US"),
        },
        {
          label: "ship data gaps",
          value: products.filter((p) => !p.shipDataOk).length.toLocaleString("en-US"),
        },
      ];

  return (
    <div className="cd-screen cd-orders-screen" data-screen-label="Products">
      <header className="cd-screen-head cd-order-page-head">
        <div>
          <h1 className="cd-h1">Products</h1>
        </div>
        <Btn kind="primary" small onClick={() => app.navigate("product-editor", "new")}>
          New product
        </Btn>
      </header>

      <OrderPageReadout items={readoutItems} ariaLabel="Products overview" />

      <div className="cd-order-section-panel">
      <Card pad={false} className="cd-order-workspace">
        <OrderListToolbar
          views={STATUS_VIEWS}
          view={status}
          onViewChange={(v) => setStatus(v as StatusFilter)}
          searchValue={search}
          searchPlaceholder="Search products"
          searchAriaLabel="Search products"
          onSearchChange={setSearch}
          filterLabel="Product"
          activeFilterCount={hasDateFilter ? 1 : 0}
          filterChildren={
            <div className="cd-orders-filter-fields">
              <div className="cd-orders-filter-daterange">
                <span className="cd-caption">Last updated</span>
                <div className="flex items-center gap-1.5">
                  <input
                    className="cd-input"
                    type="date"
                    aria-label="Updated from"
                    value={isoToDateInputValue(updatedFrom)}
                    onChange={(e) =>
                      setUpdatedFrom(e.target.value ? localDayStartIso(e.target.value) : undefined)
                    }
                  />
                  <span className="cd-caption">to</span>
                  <input
                    className="cd-input"
                    type="date"
                    aria-label="Updated to"
                    value={isoToDateInputValue(updatedTo)}
                    onChange={(e) =>
                      setUpdatedTo(e.target.value ? localDayEndIso(e.target.value) : undefined)
                    }
                  />
                </div>
              </div>
            </div>
          }
        />

        <OrderBulkBar count={selected.size}>
          <Btn small icon="check" disabled={bulkBusy} onClick={() => bulkStatus("active", "set to active")}>
            Set active
          </Btn>
          <Btn small disabled={bulkBusy} onClick={() => bulkStatus("draft", "set to draft")}>
            Set draft
          </Btn>
          {isArchivedView ? (
            <Btn small icon="archive" disabled={bulkBusy} onClick={() => bulkStatus("draft", "unarchived to draft")}>
              Unarchive to draft
            </Btn>
          ) : (
            <Btn
              small
              icon="archive"
              disabled={bulkBusy}
              onClick={() => bulkStatus("archived", "archived", `Archive ${selected.size} products?`)}
            >
              Archive
            </Btn>
          )}
          <div className="flex items-center gap-2">
            <select
              className="cd-input"
              aria-label="Collection to add to"
              value={collectionId}
              onChange={(e) => setCollectionId(e.target.value)}
              disabled={bulkBusy || !collections || collections.length === 0}
              style={{ width: 190 }}
            >
              <option value="">
                {collections === null
                  ? "Loading collections…"
                  : collections.length === 0
                    ? "No collections yet"
                    : "Add to collection…"}
              </option>
              {(collections ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <Btn small icon="tag" disabled={bulkBusy || !collectionId} onClick={bulkAddToCollection}>
              Add
            </Btn>
          </div>
        </OrderBulkBar>

        <OrderListTable
          loading={loading}
          error={error}
          empty={products.length === 0}
          filtered={filtered}
          minWidth={680}
          columns={GRID}
          emptyIcon="bag"
          emptyTitle="No products yet"
          emptySub="Create your first product to start your catalog."
          emptyActionLabel="New product"
          onEmptyAction={() => app.navigate("product-editor", "new")}
          filteredTitle="No matching products"
          filteredSub="Try a different search or filter."
          headers={
            <>
              <span>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all products on this page"
                />
              </span>
              <span aria-hidden="true" />
              <OrderSortHeader
                label="Product"
                col="title"
                sort={headerSort.sort}
                dir={headerSort.dir}
                onSort={sortByColumn}
              />
              <span>Price</span>
              <OrderSortHeader
                label="Status"
                col="status"
                sort={headerSort.sort}
                dir={headerSort.dir}
                onSort={sortByColumn}
              />
              <span>Ship data</span>
              <span />
            </>
          }
        >
          {products.map((p) => (
            // A div-with-button-semantics rather than a real <button>: each row
            // nests an interactive checkbox, which is invalid inside <button>.
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              className="cd-trow cd-order-row"
              data-selected={selected.has(p.id) ? "1" : "0"}
              onClick={() => app.navigate("product-editor", p.id)}
              onKeyDown={(e) => {
                // Only when the row itself is focused — a Space keyup on the
                // nested checkbox bubbles here and must not open the editor.
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  app.navigate("product-editor", p.id);
                }
              }}
              style={{ gridTemplateColumns: GRID, cursor: "pointer" }}
            >
              <div onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggleRow(p.id)}
                  aria-label={`Select ${p.title}`}
                />
              </div>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  overflow: "hidden",
                  background: "var(--gray-bg)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {p.imageUrl ? (
                  <img
                    src={p.imageUrl}
                    alt=""
                    loading="lazy"
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <CDIcon name="bag" size={13} />
                )}
              </div>
              <div className="cd-order-ref-cell">
                <span className="cd-row-title truncate">{p.title}</span>
                {p.variantCount > 1 && (
                  <span className="cd-order-source-label">{p.variantCount} variants</span>
                )}
              </div>
              <div className="cd-row-num tabular-nums">
                {p.priceCents != null ? money(p.priceCents) : "—"}
              </div>
              <div>
                <span className={`cd-badge${p.status === "active" ? " cd-order-badge-live" : ""}`}>
                  {p.status}
                </span>
              </div>
              <div
                className="cd-caption"
                style={p.shipDataOk ? undefined : { color: "var(--live)" }}
              >
                {shipLabel(p)}
              </div>
              <div className="cd-order-row-actions">
                <CDIcon name="chevronRight" size={15} className="cd-order-row-chevron" />
              </div>
            </div>
          ))}
        </OrderListTable>
      </Card>

      {!loading && !error && products.length < total && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <Btn disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Loading…" : `Load more (${products.length} of ${total})`}
          </Btn>
        </div>
      )}
      </div>
    </div>
  );
}
