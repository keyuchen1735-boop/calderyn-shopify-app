import { useEffect, useRef, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { Card, Btn, Pill, Placeholder, Segmented } from "../ui";
import { CDIcon } from "../icons";
import { ProductsSubTabs } from "../subtabs";

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

export default function Catalog({ app }: { app: DashboardCtx }) {
  const [products, setProducts] = useState<client.ProductSummaryVM[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<StatusFilter>("All");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
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
  const filterToken = JSON.stringify([query, statusParam ?? ""]);
  const filterRef = useRef(filterToken);
  filterRef.current = filterToken;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    client
      .fetchProducts({ search: query || undefined, status: statusParam })
      .then((r) => {
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
  }, [query, statusParam]);

  const loadMore = async () => {
    const token = filterRef.current;
    setLoadingMore(true);
    try {
      const r = await client.fetchProducts({ search: query || undefined, status: statusParam, offset: products.length });
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
        <div className="flex items-center gap-2.5">
          <Btn kind="primary" icon="plus" onClick={() => app.navigate("product-editor", "new")}>
            New product
          </Btn>
        </div>
      </header>

      <ProductsSubTabs app={app} />

      <div className="flex items-center gap-2.5" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <input
          className="cd-input"
          placeholder="Search products"
          aria-label="Search products"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: "auto", minWidth: 220, flex: "1 1 220px" }}
        />
        <Segmented small value={status} onChange={(v) => setStatus(v as StatusFilter)} options={STATUS_OPTIONS} />
      </div>

      <Card pad={false}>
        {loading ? (
          <Placeholder icon="bag" title="Loading products" sub="Reading your catalog." />
        ) : error ? (
          <Placeholder icon="warn" title="Couldn't load products" sub={error} />
        ) : products.length === 0 ? (
          <Placeholder
            icon="bag"
            title={filtered ? "No matching products" : "No products yet"}
            sub={filtered ? "Try a different search or filter." : "Create your first product to start your catalog."}
          />
        ) : (
          <div className="cd-rows">
            {products.map((p) => (
              <button key={p.id} className="cd-row" onClick={() => app.navigate("product-editor", p.id)}>
                <span
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    overflow: "hidden",
                    flexShrink: 0,
                    background: "var(--gray-bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {p.imageUrl ? (
                    <img src={p.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <CDIcon name="bag" size={16} style={{ color: "var(--text-3)" }} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="cd-row-title truncate">{p.title}</div>
                  <div className="cd-caption">
                    {p.variantCount} variant{p.variantCount === 1 ? "" : "s"}
                  </div>
                </div>
                <Pill tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status}</Pill>
                <CDIcon name="chevronRight" size={16} style={{ color: "var(--text-3)", flexShrink: 0 }} />
              </button>
            ))}
          </div>
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
