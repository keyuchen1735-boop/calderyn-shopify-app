// app/components/dashboard/screens/Discover.tsx
// Ranked viral-product feed — a subtab under the Store surface. Seeds from the
// screen cache for instant paint, then refetches. Picking a product writes the
// owned catalog + supplier link and generates a draft store.
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Card, Btn, Pill, Placeholder, TableSkeleton } from "../ui";
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

export default function Discover({ app }: { app: DashboardCtx }) {
  const [data, setData] = useState<DiscoverState | null>(() =>
    cachedScreenData<DiscoverState>(SCREEN_CACHE_KEYS.discover),
  );
  const [picking, setPicking] = useState<string | null>(null);

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
      await pickDiscoverProduct(sourceProductId);
      app.toast("Product added — building your store…", "sparkle");
      app.navigate("storefront"); // land on the Store builder with the fresh draft
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
          <div className="cd-tablehd" style={{ gridTemplateColumns: GRID }}>
            <span>Product</span>
            <span>Virality</span>
            <span>Cost</span>
            <span>Suggested</span>
            <span>Margin</span>
            <span />
          </div>
          {data.items.map((it) => (
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
        </Card>
      )}
    </div>
  );
}
