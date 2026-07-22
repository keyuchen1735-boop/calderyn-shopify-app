import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { OperatingPnlData } from "~/lib/analytics/operating-pnl";
import { fetchOperatingPnl, type OperatingPnlDays } from "~/lib/dashboard/operating-pnl-client";
import { cacheScreenData, cachedScreenData, operatingPnlCacheKey } from "~/lib/dashboard/screen-cache";
import { reduced } from "../hero/hero-motion";
import { money, shortDate } from "../format";
import { Card, Placeholder, Refetch, Segmented } from "../ui";

const explanations: Record<string, (data: OperatingPnlData) => string> = {
  income: (d) => `${money(d.statement?.incomeCents ?? 0, d.currency)} of accrual income was recognized; keep growing sales without giving back margin.`,
  gross: (d) => `After COGS, the business kept ${money((d.statement?.incomeCents ?? 0) - (d.statement?.cogsCents ?? 0), d.currency)} to cover operations and profit.`,
  net: (d) => `${money(d.statement?.netIncomeCents ?? 0, d.currency)} remained after every QuickBooks expense; protect this number as you scale.`,
  cash: (d) => `Cash changed by ${money(d.netCashFlowCents ?? 0, d.currency)} even though accrual profit was ${money(d.statement?.netIncomeCents ?? 0, d.currency)}.`,
  chart: () => "Accrual profit per period shows exactly when the business made or lost money; investigate repeated down periods.",
  statement: () => "This is the complete QuickBooks accrual trail from income through COGS and operating expenses to net income.",
  products: () => "Revenue and COGS come from your Calderyn orders; QuickBooks operating expenses and tax are spread across products by revenue share.",
};

const RANGE_OPTIONS = [
  { label: "7D", value: "7" },
  { label: "14D", value: "14" },
  { label: "30D", value: "30" },
  { label: "90D", value: "90" },
  { label: "1Y", value: "365" },
  { label: "All", value: "3650" },
];

/** Column granularity the server picked for this window (mirrors the loader). */
function periodUnit(days: OperatingPnlDays): "day" | "month" | "year" {
  return days <= 90 ? "day" : days <= 365 ? "month" : "year";
}

function Tooltip({ text, x, y }: { text: string; x: number; y: number }) {
  return (
    <div
      style={{
        position: "fixed", left: x + 16, top: y + 18, zIndex: 1000, width: 280,
        padding: "10px 12px", borderRadius: 10, color: "var(--bg)", background: "var(--text-1)",
        fontSize: 12, lineHeight: 1.45, boxShadow: "var(--shadow-pop)",
        pointerEvents: "none", animation: "cdPnlTipIn 150ms ease-out",
      }}
    >
      {text}
    </div>
  );
}

function Metric({
  label,
  value,
  explain,
  emphasis = false,
  tone,
}: {
  label: string;
  value: string;
  explain: string;
  emphasis?: boolean;
  tone?: "positive" | "negative";
}) {
  const className = [
    "cd-stat",
    "cd-pnl-stat",
    emphasis && "cd-pnl-stat--net",
    tone && `cd-pnl-stat--${tone}`,
  ].filter(Boolean).join(" ");

  return (
    <Card className={className} data-explain={explain}>
      <span style={{ color: "var(--text-2)", fontSize: 12, fontWeight: 650 }}>{label}</span>
      <strong className="tabular-nums" style={{ color: "var(--text-1)", fontSize: 28, letterSpacing: "-.04em" }}>{value}</strong>
    </Card>
  );
}

const PRODUCT_GRID = "minmax(230px,1.25fr) repeat(4,minmax(105px,.55fr)) 70px";

export default function OperatingPnl() {
  const [days, setDays] = useState<OperatingPnlDays>(30);
  const seed = cachedScreenData<OperatingPnlData>(operatingPnlCacheKey(30));
  const [data, setData] = useState<OperatingPnlData | null>(seed);
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const key = operatingPnlCacheKey(days);
    const cached = cachedScreenData<OperatingPnlData>(key);
    if (cached) setData(cached);
    // Always true while the re-query runs — the previous range stays on screen
    // dimmed (see <Refetch> below) so the chip click visibly registered.
    setLoading(true);
    setError(null);
    fetchOperatingPnl(days).then((result) => {
      cacheScreenData(key, result);
      if (alive) setData(result);
    }).catch(() => {
      if (alive) setError("Couldn't load QuickBooks profitability.");
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [days]);

  // After the first window lands, warm the rest one at a time so flipping the
  // range switches instantly. Sequential on purpose — every window is a
  // QuickBooks report pull, and firing five at once invites rate limiting.
  const warmed = useRef(false);
  useEffect(() => {
    if (loading || !data?.connected || warmed.current) return;
    warmed.current = true;
    let alive = true;
    (async () => {
      for (const option of RANGE_OPTIONS) {
        if (!alive) return;
        const windowDays = Number(option.value) as OperatingPnlDays;
        const key = operatingPnlCacheKey(windowDays);
        if (cachedScreenData<OperatingPnlData>(key)) continue;
        try {
          const result = await fetchOperatingPnl(windowDays);
          cacheScreenData(key, result);
        } catch {
          /* best-effort warmup — the on-demand fetch above still covers it */
        }
      }
    })();
    return () => { alive = false; };
  }, [loading, data]);

  // One entrance choreography per fresh dataset (first load or range change):
  // stat cards rise, chart bars grow from their baseline, product rows stagger
  // in — the same motion language as the Orders table. Skips under reduced
  // motion; clearProps returns every element to stylesheet-driven state.
  useGSAP(
    () => {
      if (reduced() || !data?.statement || !rootRef.current) return;
      const stats = rootRef.current.querySelectorAll<HTMLElement>(".cd-pnl-stat");
      const bars = rootRef.current.querySelectorAll<HTMLElement>(".cd-pnl-bar");
      const rows = rootRef.current.querySelectorAll<HTMLElement>(".cd-trow");
      const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
      if (stats.length) {
        tl.from(stats, {
          autoAlpha: 0, y: 8, duration: 0.28, stagger: 0.05,
          clearProps: "opacity,visibility,transform",
        });
      }
      if (bars.length) {
        tl.from(bars, {
          scaleY: 0, duration: 0.4, stagger: Math.min(0.012, 0.6 / bars.length),
          clearProps: "transform",
        }, "-=0.12");
      }
      if (rows.length) {
        tl.from(rows, {
          autoAlpha: 0, y: 6, duration: 0.25, stagger: 0.02,
          clearProps: "opacity,visibility,transform",
        }, "-=0.25");
      }
    },
    { dependencies: [data], scope: rootRef },
  );

  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-explain]");
    const key = target?.dataset.explain;
    if (!key || !data || !explanations[key]) return setTip(null);
    setTip({ text: explanations[key](data), x: event.clientX, y: event.clientY });
  };
  const statement = data?.statement;
  const grossProfit = (statement?.incomeCents ?? 0) - (statement?.cogsCents ?? 0);
  const chartMax = Math.max(...(statement?.daily.map((row) => Math.abs(row.netIncomeCents)) ?? [1]), 1);
  const productMax = Math.max(...(data?.products.map((row) => row.netRevenueCents) ?? [1]), 1);
  const chartAxisDates = statement?.daily.filter((_, index, rows) =>
    index === 0 || index === Math.floor((rows.length - 1) / 2) || index === rows.length - 1,
  ) ?? [];
  const unit = periodUnit(days);
  const rangeCaption = useMemo(
    () => (data ? `Live from your QuickBooks company · ${data.startDate} to ${data.endDate}` : ""),
    [data],
  );

  if (loading && !data) return <div className="cd-screen"><Placeholder /></div>;
  if (error && !data) return <div className="cd-screen"><Card><strong>{error}</strong></Card></div>;
  if (!data?.connected || !statement) return null;

  return (
    <div ref={rootRef} className="cd-screen cd-pnl" onMouseMove={onMove} onMouseLeave={() => setTip(null)}>
      <style>{`@keyframes cdPnlTipIn{from{opacity:0;transform:translateY(5px) scale(.98)}to{opacity:1;transform:none}}@media(max-width:900px){.cd-pnl-main{grid-template-columns:1fr!important}.cd-pnl-products{overflow-x:auto}.cd-pnl-products>div{min-width:880px}}`}</style>
      <header className="cd-screen-head">
        <div>
          <h1 className="cd-h1">Operating P&amp;L</h1>
          <span className="cd-caption" style={{ color: "var(--text-3)" }}>{rangeCaption}</span>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {loading && <span className="cd-spinner" role="status" aria-label="Updating" />}
          <Segmented value={String(days)} options={RANGE_OPTIONS} onChange={(value) => setDays(Number(value) as OperatingPnlDays)} />
        </span>
      </header>

      <Refetch active={loading} className="cd-refetch-wrap">
      {error && (
        <Card>
          <strong style={{ fontSize: 13, color: "var(--red)" }}>
            {error} Showing the last range that loaded — pick another range or retry.
          </strong>
        </Card>
      )}

      <div className="cd-stat-grid">
        <Metric label="Accrual income" value={money(statement.incomeCents, data.currency)} explain="income" />
        <Metric label="Gross profit" value={money(grossProfit, data.currency)} explain="gross" />
        <Metric
          label="Net profit / loss"
          value={money(statement.netIncomeCents, data.currency)}
          explain="net"
          emphasis
          tone={statement.netIncomeCents >= 0 ? "positive" : "negative"}
        />
        <Metric label="Net cash flow" value={money(data.netCashFlowCents ?? 0, data.currency)} explain="cash" />
      </div>

      <div className="cd-pnl-main" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.55fr) minmax(310px,.8fr)", gap: 14 }}>
        <Card data-explain="chart">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 20 }}>
            <strong style={{ fontSize: 15, color: "var(--text-1)" }}>P&amp;L by {unit}</strong>
            <strong className="tabular-nums" style={{ color: statement.netIncomeCents >= 0 ? "var(--green)" : "var(--red)", fontSize: 19 }}>
              {money(statement.netIncomeCents, data.currency)}
            </strong>
          </div>
          <div style={{ height: 190, display: "flex", gap: 4, position: "relative", borderBottom: "1px solid var(--hairline-strong)" }}>
            <i style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 1, background: "var(--hairline)" }} />
            {statement.daily.length === 0 && (
              <span style={{ margin: "auto", fontSize: 12, color: "var(--text-3)" }}>
                QuickBooks didn't provide a per-{unit} breakdown for this range; the totals above are still complete.
              </span>
            )}
            {statement.daily.map((row) => {
              const height = Math.max(4, Math.abs(row.netIncomeCents) / chartMax * 82);
              const positive = row.netIncomeCents >= 0;
              return (
                <div key={row.date} title={`${row.date}: ${money(row.netIncomeCents, data.currency)}`} style={{ flex: 1, height: 180, position: "relative" }}>
                  <i
                    className="cd-pnl-bar"
                    style={{
                      position: "absolute", left: 0, right: 0,
                      bottom: positive ? 90 : undefined, top: positive ? undefined : 90,
                      height, minWidth: 3, borderRadius: 3,
                      background: positive ? "var(--green)" : "var(--red)",
                      transformOrigin: positive ? "50% 100%" : "50% 0%",
                      display: "block",
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, color: "var(--text-3)", fontSize: 10, fontWeight: 650 }}>
            {chartAxisDates.map((row) => <time key={row.date} dateTime={row.date}>{shortDate(row.date)}</time>)}
          </div>
        </Card>

        <Card data-explain="statement">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <strong style={{ fontSize: 15, color: "var(--text-1)" }}>Profitability breakdown</strong>
            <span className="cd-caption" style={{ color: "var(--text-3)" }}>QuickBooks</span>
          </div>
          <div style={{ marginTop: 14 }}>
            {statement.rows.map((row, index) => (
              <div
                key={`${row.label}-${index}`}
                style={{
                  display: "grid", gridTemplateColumns: "minmax(0,1fr) 112px", alignItems: "baseline", gap: 12,
                  padding: row.total ? "9px 0" : "6px 0",
                  borderTop: row.total ? "1px solid var(--hairline-strong)" : undefined,
                  fontWeight: row.total ? 700 : 500,
                  color: row.total ? "var(--text-1)" : "var(--text-2)",
                }}
              >
                <span style={{ paddingLeft: row.depth * 9, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
                <span className="tabular-nums" style={{ textAlign: "right", fontSize: row.total ? 13 : 12 }}>{row.section ? "" : money(row.cents, data.currency)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div data-explain="products" style={{ marginTop: 14 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, gap: 12 }}>
            <strong style={{ fontSize: 15, color: "var(--text-1)" }}>Net profit by product</strong>
            <span className="cd-caption" style={{ color: "var(--text-3)", textAlign: "right" }}>
              Calderyn orders + QuickBooks expenses by revenue share
            </span>
          </div>
          <div className="cd-pnl-products cd-pnl-product-table"><div>
            <div className="cd-tablehd" style={{ gridTemplateColumns: PRODUCT_GRID, padding: "8px 10px", borderBottom: "1px solid var(--hairline-strong)" }}>
              <span>Product</span>
              <span style={{ textAlign: "right" }}>Net revenue</span>
              <span style={{ textAlign: "right" }}>COGS</span>
              <span style={{ textAlign: "right" }}>OpEx + tax</span>
              <span style={{ textAlign: "right" }}>Net P&amp;L</span>
              <span style={{ textAlign: "right" }}>Margin</span>
            </div>
            {data.products.length === 0 && (
              <div style={{ padding: "18px 10px", fontSize: 13, color: "var(--text-3)" }}>
                No product sales in this window yet. Once orders come in, each product's revenue, cost and bottom-line profit shows up here.
              </div>
            )}
            {data.products.map((product) => (
              <div key={product.id} className="cd-trow" style={{ gridTemplateColumns: PRODUCT_GRID, padding: "11px 10px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "38px minmax(0,1fr)", gap: 10, alignItems: "center" }}>
                  <div style={{ width: 38, height: 38, overflow: "hidden", borderRadius: 8, background: "var(--gray-bg)", display: "grid", placeItems: "center", color: "var(--green)", fontWeight: 800 }}>
                    {product.imageUrl ? <img src={product.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : product.title.slice(0, 1)}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, color: "var(--text-1)" }}>{product.title}</strong>
                    <span style={{ fontSize: 11, fontWeight: 650, color: "var(--text-3)" }}>{product.sku ?? "No SKU"}</span>
                  </div>
                </div>
                <div>
                  <div style={{ height: 4, borderRadius: 2, background: "var(--gray-bg)", marginBottom: 6 }}>
                    <i style={{ display: "block", height: "100%", width: `${Math.max(0, Math.min(100, product.netRevenueCents / productMax * 100))}%`, borderRadius: 2, background: "var(--green)" }} />
                  </div>
                  <div className="tabular-nums" style={{ textAlign: "right", fontWeight: 650, color: "var(--text-1)" }}>{money(product.netRevenueCents, data.currency)}</div>
                </div>
                <span className="tabular-nums" style={{ textAlign: "right", color: "var(--text-2)" }}>{money(product.cogsCents, data.currency)}</span>
                <span className="tabular-nums" style={{ textAlign: "right", color: "var(--text-2)" }}>{money(product.allocatedOperatingExpensesCents, data.currency)}</span>
                <strong className="tabular-nums" style={{ textAlign: "right", color: product.netOperatingProfitCents >= 0 ? "var(--green)" : "var(--red)" }}>{money(product.netOperatingProfitCents, data.currency)}</strong>
                <strong className="tabular-nums" style={{ textAlign: "right", color: "var(--text-1)" }}>{product.netMarginPct == null ? "—" : `${product.netMarginPct.toFixed(1)}%`}</strong>
              </div>
            ))}
          </div></div>
        </Card>
      </div>
      </Refetch>
      {tip && <Tooltip {...tip} />}
    </div>
  );
}
