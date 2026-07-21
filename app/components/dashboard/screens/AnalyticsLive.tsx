// app/components/dashboard/screens/AnalyticsLive.tsx
// Live subtab of the Analytics screen: a two-column board — current visitors,
// today's sales/orders, the behavior funnel and new-vs-returning on the left,
// an interactive globe of live sessions by country on the right — with
// locations and top products below. Split into a pure view (LiveSnapshotView,
// SSR-testable) and a thin fetching wrapper around useLiveAnalytics.
import { Card, CountMoney, CountNum, Meter, Placeholder } from "../ui";
import { useLiveAnalytics } from "../use-live-analytics";
import LiveGlobe from "../live-globe";
import type { LiveAnalyticsSnapshot } from "~/lib/dashboard/client";
import type { DashboardCtx } from "../context";
import { LiveRadarSignals } from "./radar-sections";

export function LiveSnapshotView({
  snapshot,
  error,
  dark = false,
}: {
  snapshot: LiveAnalyticsSnapshot | null;
  error: string | null;
  dark?: boolean;
}) {
  // A transient poll failure must not blank a working board: the placeholder
  // only shows when there is no snapshot to keep rendering.
  if (!snapshot) {
    const placeholder = error
      ? ({ icon: "warn", title: "Couldn't load live view", sub: error } as const)
      : ({
          icon: "chart",
          title: "Loading live view",
          sub: "Reading current storefront activity.",
        } as const);
    return (
      <Card pad={false}>
        <Placeholder {...placeholder} />
      </Card>
    );
  }

  const locMax = Math.max(...snapshot.by_location.map((l) => l.sessions), 1);
  const prodMax = Math.max(...snapshot.top_products.map((p) => p.sales_cents), 1);
  const nvr = snapshot.new_vs_returning;
  const nvrTotal = Math.max(nvr.new + nvr.returning, 1);

  return (
    <>
      <div className="cd-an-live">
        <div className="flex flex-col gap-3.5 min-w-0">
          <Card className="cd-stat">
            <span className="cd-stat-label">Visitors right now</span>
            <span className="cd-stat-value" style={{ color: "var(--live)" }}>
              <CountNum value={snapshot.visitors_now} />
            </span>
            <span className="cd-caption inline-flex items-center gap-1.5">
              <span className="cd-live-dot on" /> active in the last 5 minutes
            </span>
          </Card>
          <div className="grid grid-cols-2 gap-3.5">
            <Card className="cd-stat">
              <span className="cd-stat-label">Sales today</span>
              <span className="cd-stat-value">
                <CountMoney cents={snapshot.total_sales_today_cents} />
              </span>
            </Card>
            <Card className="cd-stat">
              <span className="cd-stat-label">Orders</span>
              <span className="cd-stat-value">
                <CountNum value={snapshot.orders_today} />
              </span>
            </Card>
          </div>
          <Card>
            <h2 className="cd-h2">Behavior</h2>
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ["Sessions", snapshot.sessions_today, undefined],
                  ["In cart", snapshot.funnel.cart_sessions, undefined],
                  ["Reached checkout", snapshot.funnel.checkout_sessions, undefined],
                  ["Purchased", snapshot.funnel.purchased_sessions, "var(--green)"],
                ] as const
              ).map(([label, n, color]) => (
                <div key={label} className="cd-stat">
                  <span className="cd-stat-label">{label}</span>
                  <span
                    className="tabular-nums"
                    style={{ fontSize: 20, fontWeight: 660, marginTop: 2, color }}
                  >
                    {n}
                  </span>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <h2 className="cd-h2">New vs returning</h2>
            <div className="cd-rows">
              {(
                [
                  ["New", nvr.new],
                  ["Returning", nvr.returning],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="cd-row">
                  <span className="cd-row-title">{label}</span>
                  <Meter pct={(n / nvrTotal) * 100} />
                  <span className="cd-row-num tabular-nums">{n}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div
          className="cd-card"
          style={{
            position: "relative",
            overflow: "hidden",
            height: "min(78vh, 780px)",
            minHeight: 520,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 12,
          }}
        >
          <LiveGlobe locations={snapshot.by_location} dark={dark} />
          <div
            style={{
              position: "absolute",
              left: 18,
              top: 16,
              display: "flex",
              alignItems: "center",
              gap: 8,
              pointerEvents: "none",
            }}
          >
            <span className="cd-live-dot on" />
            <span style={{ fontSize: 12.5, fontWeight: 640 }}>Live view</span>
            <span className="cd-caption">drag to spin</span>
          </div>
        </div>
      </div>

      <div className="cd-grid-main">
        <div className="flex flex-col gap-4 min-w-0">
          <Card>
            <h2 className="cd-h2">Locations</h2>
            {snapshot.by_location.length === 0 ? (
              <Placeholder
                icon="scan"
                title="No sessions yet"
                sub="Sessions by country will list here."
              />
            ) : (
              <div className="cd-rows">
                {snapshot.by_location.map((l) => (
                  <div key={l.country} className="cd-row">
                    <span className="cd-row-title">{l.country}</span>
                    <Meter pct={(l.sessions / locMax) * 100} />
                    <span className="cd-row-num tabular-nums">{l.sessions}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <Card>
            <h2 className="cd-h2">Top products</h2>
            {snapshot.top_products.length === 0 ? (
              <Placeholder
                icon="sparkle"
                title="No sales yet"
                sub="Today's sales by product will list here."
              />
            ) : (
              <div className="cd-rows">
                {snapshot.top_products.map((p) => (
                  <div key={p.product_id} className="cd-row">
                    <span className="cd-row-title">{p.title}</span>
                    <Meter pct={(p.sales_cents / prodMax) * 100} />
                    <span className="cd-row-num tabular-nums">
                      <CountMoney cents={p.sales_cents} /> · {p.units}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

export default function AnalyticsLive({ app, dark = false }: { app: DashboardCtx; dark?: boolean }) {
  const { snapshot, error } = useLiveAnalytics(true);
  return (
    <>
      <LiveSnapshotView snapshot={snapshot} error={error} dark={dark} />
      <LiveRadarSignals app={app} />
    </>
  );
}
