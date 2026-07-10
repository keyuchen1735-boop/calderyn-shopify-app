import { useEffect, useState } from "react";
import { Btn, Card, Pan, Pill, Placeholder, TableSkeleton } from "../ui";
import { money, timeAgo } from "../format";
import {
  DashboardApiError,
  fetchPurchaseOrders,
  type PurchaseOrderVM,
} from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import type { DashboardCtx } from "../context";

// Purchase orders are audit rows: create_po_draft snapshots the PO into the
// action_audit row's params, so this list is a dedicated paginated read over
// that trail. The snapshot carries the PO number, lines, and total; supplier /
// ETA / status fields don't exist, so they are not shown.

const GRID = "1fr 1.6fr 1fr 1.2fr";

// Outcomes are the shared action vocabulary (app/lib/action-outcome.ts):
// succeeded | retrying | anything else = failure. An unknown outcome renders
// as itself, never as a false success.
function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === "succeeded") return <Pill tone="success" icon="check">Drafted</Pill>;
  if (outcome === "retrying") return <Pill tone="warn" icon="clock">Retrying</Pill>;
  if (outcome === "failed") return <Pill tone="critical" icon="x">Failed</Pill>;
  return <Pill>{outcome}</Pill>;
}

/** Error captions come from upstream executors and can run long; keep the row
 *  scannable by capping at 80 chars. */
function trimError(message: string): string {
  const t = message.trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

function PoRow({ row }: { row: PurchaseOrderVM }) {
  return (
    <div className="cd-trow" style={{ gridTemplateColumns: GRID }}>
      <div className="cd-row-title tabular-nums truncate">
        {row.poNumber ?? row.id.slice(0, 8).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="cd-row-title truncate">{row.sku ?? "—"}</div>
        {row.lineCount > 0 && (
          <div className="cd-caption truncate">
            {row.lineCount} line{row.lineCount === 1 ? "" : "s"}
            {row.totalCents != null ? ` · ${money(row.totalCents)}` : ""}
          </div>
        )}
        {row.outcome === "failed" && row.lastError && (
          <div className="cd-caption truncate" style={{ color: "var(--orange)" }}>
            {trimError(row.lastError)}
          </div>
        )}
      </div>
      <div className="cd-caption">{timeAgo(row.createdAt)}</div>
      <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
        <OutcomeBadge outcome={row.outcome} />
        {/* The PDF route 404s unless the row's params carry the PO snapshot —
            hasPdf is that exact predicate, so the button never dead-ends. */}
        {row.hasPdf && (
          <Btn
            small
            icon="download"
            onClick={() =>
              window.open(
                `/dashboard/api/audit/${encodeURIComponent(row.id)}/po.pdf`,
                "_blank",
                "noopener",
              )
            }
          >
            Download PDF
          </Btn>
        )}
      </div>
    </div>
  );
}

type PoPage = { rows: PurchaseOrderVM[]; total: number };

export default function PurchaseOrders({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints instantly; the
  // mount fetch below revalidates and writes back through. Only the default
  // offset-0 load touches the cache — paged-in rows stay local.
  const seeded = cachedScreenData<PoPage>(SCREEN_CACHE_KEYS.purchaseOrders);
  const [rows, setRows] = useState<PurchaseOrderVM[]>(() => seeded?.rows ?? []);
  const [total, setTotal] = useState(() => seeded?.total ?? 0);
  const [loading, setLoading] = useState(() => !seeded);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const toast = app.toast;

  useEffect(() => {
    let alive = true;
    fetchPurchaseOrders({})
      .then((r) => {
        cacheScreenData(SCREEN_CACHE_KEYS.purchaseOrders, r);
        if (!alive) return;
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(
          err instanceof DashboardApiError ? err.message : "Couldn't load purchase orders.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await fetchPurchaseOrders({ offset: rows.length });
      // De-dupe by id: a draft created between pages shifts the window, so a
      // paged-in row may already be shown (avoids duplicate keys).
      setRows((cur) => {
        const seen = new Set(cur.map((p) => p.id));
        return [...cur, ...r.rows.filter((p) => !seen.has(p.id))];
      });
      setTotal(r.total);
    } catch (err) {
      toast(
        err instanceof DashboardApiError ? err.message : "Couldn't load more purchase orders.",
        "warn",
        "critical",
      );
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Products">
        <div>
          <h1 className="cd-h1">Products</h1>
          <p className="cd-sub">Purchase orders</p>
          <p className="cd-caption" style={{ marginTop: 4, maxWidth: 560 }}>
            Restock drafts Calderyn created from inventory alerts. Each one snapshots a
            supplier-ready PO you can download.
          </p>
        </div>
      </header>

      <Card pad={false}>
        {loading && rows.length === 0 ? (
          <TableSkeleton />
        ) : error && rows.length === 0 ? (
          <Placeholder icon="warn" title="Couldn't load purchase orders" sub={error} />
        ) : rows.length === 0 ? (
          <>
            <Placeholder
              icon="doc"
              title="No purchase orders yet"
              sub="Draft one from a restock alert — Calderyn snapshots it here as a downloadable PO."
            />
            <div className="flex justify-center" style={{ paddingBottom: 28 }}>
              <Btn small icon="bell" onClick={() => app.navigate("alerts")}>
                View alerts
              </Btn>
            </div>
          </>
        ) : (
          <Pan min={560}>
            <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
              <span>PO</span>
              <span>Detail</span>
              <span>Drafted</span>
              <span>Actions</span>
            </div>
            {rows.map((r) => (
              <PoRow key={r.id} row={r} />
            ))}
          </Pan>
        )}
      </Card>

      {!loading && !error && rows.length < total && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <Btn disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Loading…" : `Load more (${rows.length} of ${total})`}
          </Btn>
        </div>
      )}
    </div>
  );
}
