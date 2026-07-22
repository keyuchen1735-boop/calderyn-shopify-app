// app/components/dashboard/screens/Discover.tsx
// Ranked viral-product feed — a subtab under the Store surface. Seeds from the
// screen cache for instant paint, then refetches. Picking a product writes the
// owned catalog + supplier link and generates a draft store.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn, Pan, Pill, Placeholder, TableSkeleton } from "../ui";
import {
  OrderSortHeader,
  nextSortState,
  useSortedRowsEntrance,
} from "./OrderListFamily";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import {
  fetchDiscover,
  pickDiscoverProduct,
  type DiscoverState,
} from "~/lib/dashboard/discover-client";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const GRID = "2fr 1fr 0.8fr 0.8fr 0.7fr auto";

function scoreTone(score: number): "success" | "warn" | "neutral" {
  return score >= 70 ? "success" : score >= 40 ? "warn" : "neutral";
}

/** The feed arrives already ranked by the nightly sourcing run, which is the
 *  default and has no column of its own — the header cycle returns to it on a
 *  column's third click. */
const DEFAULT_DISCOVER_SORT = { sort: "default", dir: "desc" } as const;

type DiscoverItem = DiscoverState["items"][number];

function compareDiscover(
  a: DiscoverItem,
  b: DiscoverItem,
  sort: string,
  dir: "asc" | "desc",
): number {
  const mul = dir === "asc" ? 1 : -1;
  // Title is the tiebreak on every column so equal-valued rows keep one stable
  // order rather than whatever the previous sort left behind.
  const byTitle = a.title.localeCompare(b.title);
  switch (sort) {
    case "product":
      return mul * byTitle;
    case "virality":
      return mul * (a.score - b.score) || byTitle;
    case "cost":
      return mul * (a.unitCostCents - b.unitCostCents) || byTitle;
    case "suggested":
      return mul * (a.suggestedRetailCents - b.suggestedRetailCents) || byTitle;
    case "margin":
      return mul * (a.marginPct - b.marginPct) || byTitle;
    default:
      return 0;
  }
}

export default function Discover({ app }: { app: DashboardCtx }) {
  const [data, setData] = useState<DiscoverState | null>(() =>
    cachedScreenData<DiscoverState>(SCREEN_CACHE_KEYS.discover),
  );
  const [picking, setPicking] = useState<string | null>(null);
  const [sortState, setSortState] = useState<{ sort: string; dir: "asc" | "desc" }>(
    DEFAULT_DISCOVER_SORT,
  );

  const shown = useMemo(() => {
    const items = data?.items ?? [];
    if (sortState.sort === "default") return items;
    return [...items].sort((a, b) => compareDiscover(a, b, sortState.sort, sortState.dir));
  }, [data, sortState]);

  const headerSort = {
    sort: sortState.sort,
    dir: sortState.dir,
    onSort: (col: string) => setSortState((cur) => nextSortState(cur, col, DEFAULT_DISCOVER_SORT)),
  };

  const listRef = useRef<HTMLDivElement>(null);
  useSortedRowsEntrance(listRef, shown.map((it) => it.sourceProductId).join("|"), [
    data,
    sortState,
  ]);

  useEffect(() => {
    let live = true;
    fetchDiscover()
      .then((state) => {
        if (!live) return;
        cacheScreenData(SCREEN_CACHE_KEYS.discover, state);
        setData(state);
      })
      .catch(() => {
        /* the empty/skeleton state covers a failed first fetch */
      });
    return () => {
      live = false;
    };
  }, []);

  async function pick(sourceProductId: string) {
    setPicking(sourceProductId);
    try {
      const result = await pickDiscoverProduct(sourceProductId);
      // The auto-build can be refused (running experiment, burst limit, daily AI quota) while
      // the pick itself succeeded — say so honestly instead of announcing a build that never runs.
      if (result.storeRunId) {
        app.toast("Product added — building your store…", "sparkle");
      } else if (result.storeBuildSkipped === "experiment_running") {
        app.toast("Product added. Store rebuild skipped — decide your running experiment first.");
      } else {
        app.toast("Product added. Store rebuild skipped for now — rebuild it from the Store screen.");
      }
      app.navigate("storefront"); // land on the Store builder
    } catch {
      app.toast("Could not add that product");
    } finally {
      setPicking(null);
    }
  }

  return (
    <div className="cd-screen" data-screen-label="Discover">
      {!data ? (
        <TableSkeleton />
      ) : !data.items.length ? (
        <Placeholder
          icon="sparkle"
          title="No trending products yet"
          sub="The nightly sourcing run hasn't populated the feed. Check back shortly."
        />
      ) : (
        <Card pad={false}>
          <Pan min={640}>
          <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
            <OrderSortHeader label="Product" col="product" {...headerSort} />
            <OrderSortHeader label="Virality" col="virality" {...headerSort} />
            <OrderSortHeader label="Cost" col="cost" {...headerSort} />
            <OrderSortHeader label="Suggested" col="suggested" {...headerSort} />
            <OrderSortHeader label="Margin" col="margin" {...headerSort} />
            <span />
          </div>
          <div ref={listRef}>
          {shown.map((it) => (
            <div key={it.sourceProductId} className="cd-trow" style={{ gridTemplateColumns: GRID }}>
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {it.imageUrl && (
                  <img
                    src={it.imageUrl}
                    alt=""
                    width={28}
                    height={28}
                    style={{ borderRadius: 6, objectFit: "cover" }}
                  />
                )}
                <span>
                  {it.title}
                  <small style={{ display: "block", opacity: 0.6 }}>
                    {it.supplierName} · {it.leadTimeDays}d lead
                  </small>
                </span>
              </span>
              <span>
                <Pill tone={scoreTone(it.score)}>{it.score}</Pill>
              </span>
              <span>{money(it.unitCostCents)}</span>
              <span>{money(it.suggestedRetailCents)}</span>
              <span>{Math.round(it.marginPct * 100)}%</span>
              <span>
                <Btn
                  small
                  kind="primary"
                  icon="sparkle"
                  onClick={() => pick(it.sourceProductId)}
                  disabled={picking === it.sourceProductId}
                >
                  {picking === it.sourceProductId ? "Adding…" : "Sell this"}
                </Btn>
              </span>
            </div>
          ))}
          </div>
          </Pan>
        </Card>
      )}
    </div>
  );
}
