import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Card, Btn, CountMoney, Segmented, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import { fetchCommerceAnalytics } from "~/lib/dashboard/commerce-analytics-client";
import type {
  CommerceAnalytics,
  CommerceWindowDays,
} from "~/lib/analytics/commerce-types";
import type { DashboardCtx } from "../context";
import AnalyticsLive from "./AnalyticsLive";

type Range = "7d" | "14d" | "30d";

const RANGE_DAYS: Record<Range, CommerceWindowDays> = { "7d": 7, "14d": 14, "30d": 30 };

/* ---------- SVG series helpers ----------
 * The charts are plain scaled polylines: x spreads the points across the
 * viewBox, y maps 0..max onto the drawable band (max at the top). A flat
 * zero series draws along the bottom of the band. */

function seriesPoints(
  values: number[],
  width: number,
  yTop: number,
  yBottom: number,
): Array<[number, number]> {
  const max = Math.max(...values, 0);
  const last = values.length - 1;
  return values.map((v, i) => {
    const x = last <= 0 ? width : (i / last) * width;
    const y = max > 0 ? yBottom - (v / max) * (yBottom - yTop) : yBottom;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
}

function toPolyline(pts: Array<[number, number]>): string {
  return pts.map(([x, y]) => `${x},${y}`).join(" ");
}

function toAreaPath(pts: Array<[number, number]>, width: number, floor: number): string {
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  return `${line} L${width},${floor} L0,${floor} Z`;
}

/** "2026-07-02" → "Jul 2" (UTC — the daily buckets are UTC days). */
function dayLabel(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return date;
  return new Date(t).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const rowBetween: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

/* ---------- Header ---------- */
function ScreenHeader({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
        {sub && <p className="cd-sub">{sub}</p>}
      </div>
      {children && <div className="flex items-center gap-2.5">{children}</div>}
    </header>
  );
}

/* ---------- Building blocks ---------- */

function KpiCard({
  label,
  icon,
  value,
  spark,
  stroke,
}: {
  label: string;
  icon: string;
  value: ReactNode;
  /** Daily series behind the sparkline; omit when no real daily series exists. */
  spark?: number[];
  stroke?: string;
}) {
  return (
    <Card className="cd-stat">
      <div style={rowBetween}>
        <span className="cd-stat-label">{label}</span>
        <CDIcon name={icon} size={15} style={{ color: "var(--text-3)" }} />
      </div>
      <span className="cd-stat-value tabular-nums">{value}</span>
      {spark && spark.length >= 2 && (
        <svg className="cd-kspark" viewBox="0 0 120 24" preserveAspectRatio="none">
          <polyline
            points={toPolyline(seriesPoints(spark, 120, 4, 20))}
            fill="none"
            stroke={stroke ?? "var(--accent)"}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </Card>
  );
}

const liveDot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "var(--live)",
  display: "inline-block",
  flex: "0 0 auto",
};

function CardHead({
  icon,
  dot,
  title,
  meta,
}: {
  icon?: string;
  dot?: boolean;
  title: string;
  meta?: ReactNode;
}) {
  return (
    <div className="cd-anh-wrap">
      <div className="cd-anh">
        {dot ? <span style={liveDot} /> : icon ? <CDIcon name={icon} size={15} /> : null}
        {title}
        {meta && (
          <span style={{ marginLeft: "auto", fontWeight: 500, color: "var(--text-3)" }}>
            {meta}
          </span>
        )}
      </div>
    </div>
  );
}

function AreaLineChart({
  values,
  height,
  area = true,
}: {
  values: number[];
  height?: number;
  area?: boolean;
}) {
  const pts = seriesPoints(values, 300, 12, 112);
  return (
    <svg
      className="cd-chart"
      style={height ? { height } : undefined}
      viewBox="0 0 300 120"
      preserveAspectRatio="none"
    >
      {area && <path d={toAreaPath(pts, 300, 120)} fill="var(--accent)" fillOpacity={0.1} />}
      <polyline
        points={toPolyline(pts)}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function NoData({ minHeight }: { minHeight?: number }) {
  return (
    <div className="cd-nc-empty" style={minHeight ? { minHeight } : undefined}>
      No data yet
    </div>
  );
}

function BarRow({
  label,
  cents,
  max,
  live,
}: {
  label: ReactNode;
  cents: number;
  max: number;
  live?: boolean;
}) {
  const width = max > 0 ? Math.max(2, Math.round((cents / max) * 100)) : 0;
  const fill = live ? "var(--live)" : "var(--accent)";
  return (
    <div className="cd-bar-row">
      <span
        className="cd-bl"
        style={live ? { display: "flex", alignItems: "center", gap: 6 } : undefined}
      >
        {live && <span style={liveDot} />}
        {label}
      </span>
      <div className="cd-bar-track">
        <div className="cd-bar-fill" style={{ width: `${width}%`, background: fill }} />
      </div>
      <span className="cd-bar-val">{money(cents)}</span>
    </div>
  );
}

function BreakdownLine({
  label,
  value,
  negative,
  net,
  first,
}: {
  label: string;
  value: number;
  /** Renders red with a leading minus (refund-style line). */
  negative?: boolean;
  /** The bold net row with the strong divider. */
  net?: boolean;
  first?: boolean;
}) {
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: net ? "10px 0" : "8px 0",
    fontSize: net ? 14 : 13.5,
    ...(first
      ? {}
      : { boxShadow: `inset 0 ${net ? "1px" : "0.5px"} 0 var(--hairline-strong)` }),
  };
  return (
    <div style={style}>
      <span style={net ? { fontWeight: 600 } : { color: "var(--text-2)" }}>{label}</span>
      <b
        className="tabular-nums"
        style={negative && value > 0 ? { color: "var(--red)" } : undefined}
      >
        {negative && value > 0 ? money(-value) : money(value)}
      </b>
    </div>
  );
}

function FunnelStage({
  label,
  count,
  pct,
  done,
}: {
  label: string;
  count: number;
  pct: number;
  done?: boolean;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span style={{ color: "var(--text-2)" }}>{label}</span>
        <b className="tabular-nums">{count.toLocaleString()}</b>
      </div>
      <div className="cd-bar-track" style={{ marginTop: 6 }}>
        <div
          className="cd-bar-fill"
          style={{
            width: `${Math.max(count > 0 ? 2 : 0, Math.round(pct))}%`,
            background: done ? "var(--green)" : "var(--accent)",
          }}
        />
      </div>
    </div>
  );
}

function AgenticStat({
  label,
  value,
  caption,
  captionTone,
}: {
  label: string;
  value: ReactNode;
  caption: string;
  captionTone?: string;
}) {
  return (
    <div className="cd-stat">
      <span className="cd-stat-label">{label}</span>
      <span className="cd-stat-value tabular-nums">{value}</span>
      <span className="cd-caption" style={captionTone ? { color: captionTone } : undefined}>
        {caption}
      </span>
    </div>
  );
}

/* ---------- Screen ---------- */

export default function Analytics({ app }: { app: DashboardCtx }) {
  const [range, setRange] = useState<Range>("30d");
  // Performance ↔ Live rides the URL (/dashboard/analytics vs /analytics/live)
  // so both subtabs are deep-linkable and back-button friendly.
  const view: "performance" | "live" = app.nav.sub === "live" ? "live" : "performance";
  const [data, setData] = useState<CommerceAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The 7d/14d/30d segment re-queries the endpoint — the window is aggregated
  // server-side, not sliced client-side.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchCommerceAnalytics(RANGE_DAYS[range])
      .then((res) => {
        if (!alive) return;
        setData(res);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(
          err instanceof DashboardApiError ? err.message : "Couldn't load analytics.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [range]);

  // The Performance ↔ Live subtab switch, present in every header state so the
  // Live view stays reachable while Performance is still loading or errored.
  // The Agentic channel button rides along here — it lost its top-level nav
  // item in the grouped IA, and Analytics is its entry point.
  const viewSwitch = (
    <>
      <Segmented
        small
        value={view}
        onChange={(v) => app.navigate("analytics", null, v === "live" ? "live" : "perf")}
        options={[
          { value: "performance", label: "Performance" },
          { value: "live", label: "Live" },
        ]}
      />
      <Btn small icon="bot" onClick={() => app.navigate("agentic")}>
        Agentic channel
      </Btn>
    </>
  );

  // The Live subtab is fully independent of the performance fetch — bail out
  // before the loading/error states so those never leak into (or block) it.
  if (view === "live") {
    return (
      <div className="cd-screen">
        <ScreenHeader title="Analytics" sub="Your storefront right now.">
          {viewSwitch}
        </ScreenHeader>
        <AnalyticsLive dark={!!app.t.dark} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="cd-screen">
        <ScreenHeader title="Analytics" sub="Loading sales, sessions and conversion…">
          {viewSwitch}
        </ScreenHeader>
        <Card pad={false}>
          <Placeholder icon="chart" title="Loading analytics" sub="Reading orders, sessions and channel mix." />
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="cd-screen">
        <ScreenHeader title="Analytics">{viewSwitch}</ScreenHeader>
        <Card pad={false}>
          <Placeholder icon="warn" title="Couldn't load analytics" sub={error ?? "No data returned."} />
        </Card>
      </div>
    );
  }

  const { daily, totals, byChannel, topProducts, funnel, agentic } = data;
  const haveSales = totals.orders > 0;
  const haveSessions = funnel.sessions > 0;

  const channelMax = byChannel.length ? Math.max(...byChannel.map((c) => c.grossCents)) : 0;
  const productMax = topProducts.length ? Math.max(...topProducts.map((p) => p.grossCents)) : 0;

  // Conversion series: only days that had sessions carry a real rate.
  const conversionDays = daily.filter((d) => d.conversionPct != null);
  const conversionValues = conversionDays.map((d) => d.conversionPct ?? 0);
  const latestConversion = conversionValues.length
    ? conversionValues[conversionValues.length - 1]
    : null;
  const funnelPct = funnel.sessions > 0 ? (funnel.purchases / funnel.sessions) * 100 : null;

  return (
    <div className="cd-screen">
      <ScreenHeader title="Analytics" sub="Sales, sessions and channels across your store.">
        {viewSwitch}
        <Segmented
          small
          value={range}
          onChange={(v) => setRange(v as Range)}
          options={["7d", "14d", "30d"]}
        />
      </ScreenHeader>

      {/* kpi row */}
      <div className="cd-stat-grid">
        <KpiCard
          label="Gross sales"
          icon="coin"
          value={<CountMoney cents={totals.grossCents} />}
          spark={haveSales ? daily.map((d) => d.grossCents) : undefined}
          stroke="var(--green)"
        />
        {/* No per-day returning series exists, so this card carries no sparkline. */}
        <KpiCard
          label="Returning customers"
          icon="user"
          value={totals.returningPct == null ? "—" : `${Math.round(totals.returningPct)}%`}
        />
        <KpiCard
          label="Orders fulfilled"
          icon="box"
          value={totals.fulfilled.toLocaleString()}
          spark={haveSales ? daily.map((d) => d.fulfilled) : undefined}
          stroke="var(--accent)"
        />
        <KpiCard
          label="Orders"
          icon="doc"
          value={totals.orders.toLocaleString()}
          spark={haveSales ? daily.map((d) => d.orders) : undefined}
          stroke="var(--green)"
        />
      </div>

      {/* sales over time + breakdown */}
      <div className="cd-grid-main">
        <Card>
          <CardHead
            icon="coin"
            title="Sales over time"
            meta={`${money(totals.grossCents)} gross · ${totals.orders.toLocaleString()} orders`}
          />
          {haveSales ? (
            <>
              <AreaLineChart values={daily.map((d) => d.grossCents)} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                <span className="cd-caption">{dayLabel(daily[0].date)}</span>
                <span className="cd-caption">{dayLabel(daily[daily.length - 1].date)}</span>
              </div>
            </>
          ) : (
            <NoData minHeight={190} />
          )}
        </Card>
        <Card>
          <CardHead icon="chart" title="Sales breakdown" />
          <div style={{ display: "flex", flexDirection: "column" }}>
            {/* No discounts field exists on the order spine, so no Discounts line. */}
            <BreakdownLine first label="Gross sales" value={totals.grossCents} />
            <BreakdownLine negative label="Refunds" value={totals.refundCents} />
            <BreakdownLine net label="Net sales" value={totals.netCents} />
            <BreakdownLine label="Shipping" value={totals.shippingCents} />
            <BreakdownLine label="Tax collected" value={totals.taxCents} />
          </div>
        </Card>
      </div>

      {/* channel + products */}
      <div className="cd-grid-duo">
        <Card>
          <CardHead icon="layers" title="Sales by channel" />
          {byChannel.length === 0 ? (
            <NoData />
          ) : (
            byChannel.map((c) => (
              <BarRow
                key={c.label}
                label={c.label}
                cents={c.grossCents}
                max={channelMax}
                live={c.agentic}
              />
            ))
          )}
        </Card>
        <Card>
          <CardHead icon="tag" title="Top products by sales" />
          {topProducts.length === 0 ? (
            <NoData />
          ) : (
            topProducts.map((p) => (
              <BarRow key={p.title} label={p.title} cents={p.grossCents} max={productMax} />
            ))
          )}
        </Card>
      </div>

      {/* sessions / conversion / funnel */}
      <div className="cd-an3">
        <Card>
          <CardHead icon="gauge" title="Sessions over time" />
          {haveSessions ? (
            <>
              <AreaLineChart values={daily.map((d) => d.sessions)} height={128} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                <span className="cd-caption">{funnel.sessions.toLocaleString()} total</span>
                <span className="cd-caption">last {data.days} days</span>
              </div>
            </>
          ) : (
            <NoData minHeight={128} />
          )}
        </Card>
        <Card>
          <CardHead icon="arrowUpRight" title="Conversion rate over time" />
          {conversionValues.length >= 2 ? (
            <>
              <AreaLineChart values={conversionValues} height={128} area={false} />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
                <span className="cd-caption">
                  {latestConversion == null ? "—" : `${latestConversion.toFixed(1)}% latest`}
                </span>
                <span className="cd-caption">orders ÷ sessions, per day</span>
              </div>
            </>
          ) : (
            <NoData minHeight={128} />
          )}
        </Card>
        <Card>
          <CardHead icon="radar" title="Conversion funnel" />
          {haveSessions ? (
            <>
              <div className="cd-stat-value tabular-nums" style={{ fontSize: 26 }}>
                {funnelPct == null ? "—" : `${funnelPct.toFixed(1)}%`}
              </div>
              <p className="cd-caption" style={{ margin: "2px 0 14px" }}>
                session to completed order
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
                <FunnelStage label="Sessions" count={funnel.sessions} pct={100} />
                <FunnelStage
                  label="Added to cart"
                  count={funnel.carts}
                  pct={(funnel.carts / funnel.sessions) * 100}
                />
                <FunnelStage
                  label="Reached checkout"
                  count={funnel.checkouts}
                  pct={(funnel.checkouts / funnel.sessions) * 100}
                />
                <FunnelStage
                  done
                  label="Completed"
                  count={funnel.purchases}
                  pct={(funnel.purchases / funnel.sessions) * 100}
                />
              </div>
            </>
          ) : (
            <NoData minHeight={128} />
          )}
        </Card>
      </div>

      {/* agentic channel */}
      <Card hover onClick={() => app.navigate("agentic")}>
        <CardHead
          dot
          title="Agentic channel"
          meta="External AI assistants · ChatGPT, Claude, Perplexity"
        />
        <div className="cd-stat-grid">
          <AgenticStat
            label="Connected assistants"
            value={agentic.connectedClients == null ? "—" : agentic.connectedClients.toLocaleString()}
            caption="commerce-scope clients"
          />
          <AgenticStat
            label="Quotes issued · 30d"
            value={agentic.quotes30d == null ? "—" : agentic.quotes30d.toLocaleString()}
            caption="real-time pricing"
          />
          <AgenticStat
            label="Orders placed"
            value={agentic.orders == null ? "—" : agentic.orders.toLocaleString()}
            caption={agentic.gmvCents == null ? "—" : `${money(agentic.gmvCents)} GMV`}
            captionTone={agentic.gmvCents ? "var(--green)" : undefined}
          />
          <AgenticStat
            label="GMV"
            value={agentic.gmvCents == null ? "—" : money(agentic.gmvCents)}
            caption="paid agentic orders"
          />
        </div>
      </Card>
    </div>
  );
}
