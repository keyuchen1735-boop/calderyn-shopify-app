import { useEffect, useState } from "react";
import { Card, Pill, Placeholder, TableSkeleton } from "../ui";
import { ProductsSubTabs } from "../subtabs";
import { fetchSkus, DashboardApiError } from "~/lib/dashboard/client";
import type { DashboardCtx } from "../context";
import type { SkuVM } from "../view-models";

// Design table: SKU / On hand / Status. The reference mock also shows
// Reserved and Available columns, but the shop-wide SKU read (v_skus_flat via
// fetchSkus) only carries on_hand — reserved/available live in the
// inventory_balance ledger, which today exposes only a per-variant read
// (getVariantBalances). Rather than zero-fill two columns with no real
// source, they are omitted until a shop-wide balances read exists.
const GRID = "2fr 1fr 1fr";

type StockStatus = { label: string; tone: "success" | "warn" | "critical" };

/** Stock-level badge from real signals only: on_hand === 0 is out of stock;
 * "Low" rides the velocity-based cover statuses the SKU adapter derives
 * (risk < 10d, reorder < 21d of cover) — there is no per-SKU reorder-point
 * field on this read, so days-of-cover is the real low-stock signal. */
function stockStatus(s: SkuVM): StockStatus {
  if (s.status === "stockout") return { label: "Out of stock", tone: "critical" };
  if (s.status === "risk" || s.status === "reorder") return { label: "Low", tone: "warn" };
  return { label: "Healthy", tone: "success" };
}

export default function Inventory({ app }: { app: DashboardCtx }) {
  const [skus, setSkus] = useState<SkuVM[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchSkus()
      .then((rows) => {
        if (alive) setSkus(rows);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof DashboardApiError ? err.message : "Couldn't load inventory.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Products">
        <div>
          <h1 className="cd-h1">Products</h1>
          <p className="cd-sub">
            {loading ? "Loading SKUs across your locations…" : `${skus.length} tracked SKUs`}
          </p>
        </div>
      </header>

      <ProductsSubTabs app={app} />

      <Card pad={false}>
        {loading ? (
          <TableSkeleton />
        ) : error ? (
          <Placeholder icon="warn" title="Couldn't load inventory" sub={error} />
        ) : skus.length === 0 ? (
          <Placeholder icon="box" title="No SKUs" sub="Connect a store and your tracked SKUs will appear here." />
        ) : (
          <>
            <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
              <span>SKU</span>
              <span>On hand</span>
              <span>Status</span>
            </div>
            {skus.map((s) => {
              const st = stockStatus(s);
              return (
                <div key={s.id} className="cd-trow" style={{ gridTemplateColumns: GRID }}>
                  <div className="min-w-0">
                    <div className="cd-row-title truncate">{s.title}</div>
                    <div className="cd-caption truncate">{s.sku}</div>
                  </div>
                  <div
                    className="cd-row-num tabular-nums"
                    style={s.on_hand === 0 ? { color: "var(--red)" } : undefined}
                  >
                    {s.on_hand}
                  </div>
                  <div>
                    <Pill tone={st.tone}>{st.label}</Pill>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </Card>
    </div>
  );
}
