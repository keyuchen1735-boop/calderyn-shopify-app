// app/components/dashboard/screens/AnalyticsLive.tsx
// Live subtab of the Analytics screen (spec
// 2026-07-02-analytics-live-view-design.md). Data plumbing + plain cd-*
// rendering only — final visual design is owned by the design pass; the
// LiveAnalyticsSnapshot DTO is the handoff contract. Split into a pure view
// (LiveSnapshotView, SSR-testable) and a thin fetching wrapper.
import { Card, CountMoney, CountNum, Meter, Placeholder } from "../ui";
import { useLiveAnalytics } from "../use-live-analytics";
import type { LiveAnalyticsSnapshot } from "~/lib/dashboard/client";

export function LiveSnapshotView({
  snapshot,
  error,
}: {
  snapshot: LiveAnalyticsSnapshot | null;
  error: string | null;
}) {
  if (error) {
    return (
      <Card pad={false}>
        <Placeholder icon="warn" title="Couldn't load live view" sub={error} />
      </Card>
    );
  }
  if (!snapshot) {
    return (
      <Card pad={false}>
        <Placeholder
          icon="chart"
          title="Loading live view"
          sub="Reading current storefront activity."
        />
      </Card>
    );
  }

  const funnelMax = Math.max(snapshot.funnel.cart_sessions, 1);
  const locMax = Math.max(...snapshot.by_location.map((l) => l.sessions), 1);
  const prodMax = Math.max(...snapshot.top_products.map((p) => p.sales_cents), 1);
  const nvr = snapshot.new_vs_returning;
  const nvrTotal = Math.max(nvr.new + nvr.returning, 1);

  return (
    <>
      <div className="cd-stat-grid">
        <Card className="cd-stat">
          <span className="cd-stat-label">
            <span className="cd-dot" /> Visitors right now
          </span>
          <span className="cd-stat-value">
            <CountNum value={snapshot.visitors_now} />
          </span>
          <span className="cd-caption">active in the last 5 minutes</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Sales today</span>
          <span className="cd-stat-value">
            <CountMoney cents={snapshot.total_sales_today_cents} />
          </span>
          <span className="cd-caption">{snapshot.orders_today} paid orders</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Sessions</span>
          <span className="cd-stat-value">
            <CountNum value={snapshot.sessions_today} />
          </span>
          <span className="cd-caption">since store midnight</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Orders</span>
          <span className="cd-stat-value">
            <CountNum value={snapshot.orders_today} />
          </span>
          <span className="cd-caption">paid today</span>
        </Card>
      </div>

      <div className="cd-grid-main">
        <div className="flex flex-col gap-4 min-w-0">
          <Card>
            <h2 className="cd-h2">Behavior</h2>
            <div className="cd-rows">
              {(
                [
                  ["Carts", snapshot.funnel.cart_sessions],
                  ["Checkouts", snapshot.funnel.checkout_sessions],
                  ["Purchased", snapshot.funnel.purchased_sessions],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="cd-row">
                  <span className="cd-row-title">{label}</span>
                  <Meter pct={(n / funnelMax) * 100} />
                  <span className="cd-row-num tabular-nums">{n}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <h2 className="cd-h2">New vs returning</h2>
            <div className="cd-rows">
              <div className="cd-row">
                <span className="cd-row-title">New</span>
                <Meter pct={(nvr.new / nvrTotal) * 100} />
                <span className="cd-row-num tabular-nums">{nvr.new}</span>
              </div>
              <div className="cd-row">
                <span className="cd-row-title">Returning</span>
                <Meter pct={(nvr.returning / nvrTotal) * 100} />
                <span className="cd-row-num tabular-nums">{nvr.returning}</span>
              </div>
            </div>
          </Card>
        </div>
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

export default function AnalyticsLive() {
  const { snapshot, error } = useLiveAnalytics(true);
  return <LiveSnapshotView snapshot={snapshot} error={error} />;
}
