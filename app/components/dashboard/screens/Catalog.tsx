import { useEffect, useRef, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, catalogCacheKey } from "~/lib/dashboard/screen-cache";
import { Card, Btn, Pill, Placeholder, Segmented, TableSkeleton } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import { CATALOG_SORTS, isCatalogSort, type CatalogSort } from "./catalog-list-state";

type StatusFilter = "All" | "active" | "draft" | "archived";

const STATUS_TONE: Record<string, "success" | "neutral" | "warn"> = {
  active: "success",
  draft: "neutral",
  archived: "warn",
};

const STATUS_OPTIONS = [
  { value: "All", label: "All" },
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "archived", label: "Archived" },
];

// Design table: thumbnail / Product / Price / Status / Ship data.
const GRID = "44px 2fr 1fr 1fr 1fr";

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
  const [loading, setLoading] = useState(() => !seeded);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Debounce the search box so each keystroke doesn't fire a request.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const statusParam = status === "All" ? undefined : status;

  // Latest filter identity, read after an async load to detect a filter change
  // that happened while the request was in flight (a closure-captured copy can't,
  // since it would equal itself). Updated every render.
  const filterToken = JSON.stringify([query, statusParam ?? "", sort]);
  const filterRef = useRef(filterToken);
  filterRef.current = filterToken;

  useEffect(() => {
    let alive = true;
    // Only the default sort seeds/writes the cache — a non-default sort is
    // live-fetch-only so it never poisons the seeded default view.
    const key = catalogCacheKey(query, statusParam);
    const cached = sort === "updated" ? cachedScreenData<CatalogPage>(key) : undefined;
    if (cached) {
      // Last-known rows for this filter paint immediately — no skeleton, no
      // "Loading…" caption; the fetch below silently revalidates them.
      setProducts(cached.products);
      setTotal(cached.total);
    }
    setLoading(!cached);
    setError(null);
    client
      .fetchProducts({ search: query || undefined, status: statusParam, sort })
      .then((r) => {
        if (sort === "updated") cacheScreenData(key, { products: r.products, total: r.total });
        if (!alive) return;
        setProducts(r.products);
        setTotal(r.total);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof DashboardApiError ? err.message : "Couldn't load products.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [query, statusParam, sort]);

  const loadMore = async () => {
    const token = filterRef.current;
    setLoadingMore(true);
    try {
      const r = await client.fetchProducts({ search: query || undefined, status: statusParam, sort, offset: products.length });
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

  const filtered = Boolean(query) || status !== "All";

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Products">
        <div>
          <h1 className="cd-h1">Products</h1>
          <p className="cd-sub">
            {loading ? "Loading your catalog…" : `${total} product${total === 1 ? "" : "s"} in your catalog`}
          </p>
        </div>
        {/* Deliberate addition over the reference table: without a create
            entry point the catalog can never gain a product. */}
        <div className="flex items-center gap-2.5">
          <Btn kind="primary" icon="plus" onClick={() => app.navigate("product-editor", "new")}>
            New product
          </Btn>
        </div>
      </header>

      <div className="flex items-center gap-2.5" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: "1 1 220px", minWidth: 220 }}>
          <input
            className="cd-input"
            placeholder="Search products"
            aria-label="Search products"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", paddingRight: search ? 30 : undefined }}
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                background: "none",
                border: 0,
                color: "inherit",
                cursor: "pointer",
              }}
            >
              <CDIcon name="x" size={13} />
            </button>
          )}
        </div>
        <Segmented small value={status} onChange={(v) => setStatus(v as StatusFilter)} options={STATUS_OPTIONS} />
        <select
          className="cd-input"
          value={sort}
          onChange={(e) => {
            if (isCatalogSort(e.target.value)) setSort(e.target.value);
          }}
          aria-label="Sort products"
          style={{ width: "auto" }}
        >
          {CATALOG_SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <Card pad={false}>
        {loading ? (
          <TableSkeleton />
        ) : error ? (
          <Placeholder icon="warn" title="Couldn't load products" sub={error} />
        ) : products.length === 0 ? (
          <Placeholder
            icon="bag"
            title={filtered ? "No matching products" : "No products yet"}
            sub={filtered ? "Try a different search or filter." : "Create your first product to start your catalog."}
            actionLabel={filtered ? undefined : "New product"}
            onAction={filtered ? undefined : () => app.navigate("product-editor", "new")}
          />
        ) : (
          <>
            <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
              <span aria-hidden="true" />
              <span>Product</span>
              <span>Price</span>
              <span>Status</span>
              <span>Ship data</span>
            </div>
            {products.map((p) => (
              <button
                key={p.id}
                type="button"
                className="cd-trow"
                onClick={() => app.navigate("product-editor", p.id)}
                style={{
                  gridTemplateColumns: GRID,
                  width: "100%",
                  background: "none",
                  border: 0,
                  font: "inherit",
                  color: "inherit",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
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
                    <CDIcon name="bag" size={15} />
                  )}
                </div>
                <div>
                  <div className="cd-row-title truncate">{p.title}</div>
                  {p.variantCount > 1 && (
                    <div className="cd-caption">
                      {p.variantCount} variant{p.variantCount === 1 ? "" : "s"}
                    </div>
                  )}
                </div>
                <div className="cd-row-num tabular-nums">
                  {p.priceCents != null ? money(p.priceCents) : "—"}
                </div>
                <div>
                  <Pill tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status}</Pill>
                </div>
                <div
                  className="cd-caption"
                  style={p.shipDataOk ? undefined : { color: "var(--orange)" }}
                >
                  {shipLabel(p)}
                </div>
              </button>
            ))}
          </>
        )}
      </Card>

      {!loading && !error && products.length < total && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <Btn disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Loading…" : `Load more (${products.length} of ${total})`}
          </Btn>
        </div>
      )}
    </div>
  );
}
