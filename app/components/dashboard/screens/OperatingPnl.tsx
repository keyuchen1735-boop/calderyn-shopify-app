import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type { OperatingPnlData } from "~/lib/analytics/operating-pnl";
import { fetchOperatingPnl } from "~/lib/dashboard/operating-pnl-client";
import { cacheScreenData, cachedScreenData, operatingPnlCacheKey } from "~/lib/dashboard/screen-cache";
import { money } from "../format";
import { Card, Placeholder, Segmented } from "../ui";

type Days = 7 | 14 | 30;

const NAVY = "#132238";
const EMERALD = "#16866f";
const PAPER = "#f7f4ed";

const explanations: Record<string, (data: OperatingPnlData) => string> = {
  income: (d) => `${money(d.statement?.incomeCents ?? 0, d.currency)} of accrual income was recognized; keep growing sales without giving back margin.`,
  gross: (d) => `After COGS, the business kept ${money((d.statement?.incomeCents ?? 0) - (d.statement?.cogsCents ?? 0), d.currency)} to cover operations and profit.`,
  net: (d) => `${money(d.statement?.netIncomeCents ?? 0, d.currency)} remained after every QuickBooks expense; protect this number as you scale.`,
  cash: (d) => `Cash changed by ${money(d.netCashFlowCents ?? 0, d.currency)} even though accrual profit was ${money(d.statement?.netIncomeCents ?? 0, d.currency)}.`,
  chart: () => "Daily accrual profit shows exactly when the business made or lost money; investigate repeated down days.",
  statement: () => "This is the complete QuickBooks accrual trail from income through COGS and operating expenses to net income.",
  products: () => "Operating expenses and tax are allocated by each product's net-revenue share to show a true bottom-line product P&L.",
};

function Tooltip({ text, x, y }: { text: string; x: number; y: number }) {
  return (
    <div style={{
      position: "fixed", left: x + 16, top: y + 18, zIndex: 1000, width: 280,
      padding: "10px 12px", borderRadius: 10, color: PAPER, background: NAVY,
      fontSize: 12, lineHeight: 1.45, boxShadow: "0 12px 34px #13223833",
      pointerEvents: "none", animation: "cdPnlTipIn 150ms ease-out",
    }}>{text}</div>
  );
}

function Metric({ label, value, explain }: { label: string; value: string; explain: string }) {
  return (
    <Card className="cd-stat" data-explain={explain}>
      <span style={{ color: NAVY, fontSize: 12, fontWeight: 650 }}>{label}</span>
      <strong className="tabular-nums" style={{ color: NAVY, fontSize: 28, letterSpacing: "-.04em" }}>{value}</strong>
    </Card>
  );
}

export default function OperatingPnl() {
  const [days, setDays] = useState<Days>(30);
  const seed = cachedScreenData<OperatingPnlData>(operatingPnlCacheKey(30));
  const [data, setData] = useState<OperatingPnlData | null>(seed);
  const [loading, setLoading] = useState(!seed);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const key = operatingPnlCacheKey(days);
    const cached = cachedScreenData<OperatingPnlData>(key);
    if (cached) setData(cached);
    setLoading(!cached);
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
  const range = useMemo(() => ([
    { label: "7D", value: "7" }, { label: "14D", value: "14" }, { label: "30D", value: "30" },
  ]), []);

  if (loading && !data) return <div className="cd-screen"><Placeholder /></div>;
  if (error && !data) return <div className="cd-screen"><Card><strong>{error}</strong></Card></div>;
  if (!data?.connected || !statement) return null;

  return (
    <div className="cd-screen" onMouseMove={onMove} onMouseLeave={() => setTip(null)} style={{ color: NAVY }}>
      <style>{`@keyframes cdPnlTipIn{from{opacity:0;transform:translateY(5px) scale(.98)}to{opacity:1;transform:none}}@media(max-width:900px){.cd-pnl-main{grid-template-columns:1fr!important}.cd-pnl-products{overflow-x:auto}.cd-pnl-products>div{min-width:880px}}`}</style>
      <header className="cd-screen-head">
        <div><h1 className="cd-h1">Operating P&amp;L</h1></div>
        <Segmented value={String(days)} options={range} onChange={(value) => setDays(Number(value) as Days)} />
      </header>

      <div className="cd-stat-grid">
        <Metric label="Accrual income" value={money(statement.incomeCents, data.currency)} explain="income" />
        <Metric label="Gross profit" value={money(grossProfit, data.currency)} explain="gross" />
        <Metric label="Net profit / loss" value={money(statement.netIncomeCents, data.currency)} explain="net" />
        <Metric label="Net cash flow" value={money(data.netCashFlowCents ?? 0, data.currency)} explain="cash" />
      </div>

      <div className="cd-pnl-main" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.55fr) minmax(310px,.8fr)", gap: 14 }}>
        <Card data-explain="chart">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 20 }}>
            <strong style={{ fontSize: 15 }}>P&amp;L by day</strong>
            <strong className="tabular-nums" style={{ color: statement.netIncomeCents >= 0 ? EMERALD : NAVY, fontSize: 19 }}>{money(statement.netIncomeCents, data.currency)}</strong>
          </div>
          <div style={{ height: 190, display: "flex", gap: 4, position: "relative", borderBottom: `1px solid ${NAVY}22` }}>
            <i style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 1, background: `${NAVY}22` }} />
            {statement.daily.map((row) => {
              const height = Math.max(4, Math.abs(row.netIncomeCents) / chartMax * 82);
              return <div key={row.date} title={`${row.date}: ${money(row.netIncomeCents, data.currency)}`} style={{ flex: 1, height: 180, position: "relative" }}>
                <i style={{ position: "absolute", left: 0, right: 0, bottom: row.netIncomeCents >= 0 ? 90 : undefined, top: row.netIncomeCents < 0 ? 90 : undefined, height, minWidth: 3, borderRadius: 3, background: row.netIncomeCents >= 0 ? EMERALD : NAVY, display: "block" }} />
              </div>;
            })}
          </div>
        </Card>

        <Card data-explain="statement">
          <strong style={{ fontSize: 15 }}>Profitability breakdown</strong>
          <div style={{ marginTop: 14 }}>
            {statement.rows.map((row, index) => (
              <div key={`${row.label}-${index}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 112px", alignItems: "baseline", gap: 12, padding: row.total ? "9px 0" : "6px 0", borderTop: row.total ? `1px solid ${NAVY}22` : undefined, fontWeight: row.total ? 700 : 500 }}>
                <span style={{ paddingLeft: row.depth * 9, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
                <span className="tabular-nums" style={{ textAlign: "right", fontSize: row.total ? 13 : 12 }}>{row.section ? "" : money(row.cents, data.currency)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div data-explain="products" style={{ marginTop: 14 }}><Card>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <strong style={{ fontSize: 15 }}>Net profit by product</strong>
          <span style={{ fontSize: 12, fontWeight: 650 }}>OpEx + tax by net revenue</span>
        </div>
        <div className="cd-pnl-products"><div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(230px,1.25fr) repeat(4,minmax(105px,.55fr)) 70px", gap: 12, padding: "8px 10px", fontSize: 11, fontWeight: 700, borderBottom: `1px solid ${NAVY}22` }}>
          <span>Product</span><span style={{ textAlign: "right" }}>Net revenue</span><span style={{ textAlign: "right" }}>COGS</span><span style={{ textAlign: "right" }}>OpEx + tax</span><span style={{ textAlign: "right" }}>Net P&amp;L</span><span style={{ textAlign: "right" }}>Margin</span>
        </div>
        {data.products.map((product) => (
          <div key={product.id} style={{ display: "grid", gridTemplateColumns: "minmax(230px,1.25fr) repeat(4,minmax(105px,.55fr)) 70px", gap: 12, alignItems: "center", padding: "11px 10px", borderBottom: `1px solid ${NAVY}14` }}>
            <div style={{ display: "grid", gridTemplateColumns: "38px minmax(0,1fr)", gap: 10, alignItems: "center" }}>
              <div style={{ width: 38, height: 38, overflow: "hidden", borderRadius: 8, background: PAPER, display: "grid", placeItems: "center", color: EMERALD, fontWeight: 800 }}>
                {product.imageUrl ? <img src={product.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : product.title.slice(0, 1)}
              </div>
              <div style={{ minWidth: 0 }}><strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>{product.title}</strong><span style={{ fontSize: 11, fontWeight: 650 }}>{product.sku ?? "No SKU"}</span></div>
            </div>
            <div>
              <div style={{ height: 4, borderRadius: 2, background: PAPER, marginBottom: 6 }}><i style={{ display: "block", height: "100%", width: `${Math.max(0, Math.min(100, product.netRevenueCents / productMax * 100))}%`, borderRadius: 2, background: EMERALD }} /></div>
              <div className="tabular-nums" style={{ textAlign: "right", fontWeight: 650 }}>{money(product.netRevenueCents, data.currency)}</div>
            </div>
            <span className="tabular-nums" style={{ textAlign: "right" }}>{money(product.cogsCents, data.currency)}</span>
            <span className="tabular-nums" style={{ textAlign: "right" }}>{money(product.allocatedOperatingExpensesCents, data.currency)}</span>
            <strong className="tabular-nums" style={{ textAlign: "right", color: product.netOperatingProfitCents >= 0 ? EMERALD : NAVY }}>{money(product.netOperatingProfitCents, data.currency)}</strong>
            <strong className="tabular-nums" style={{ textAlign: "right" }}>{product.netMarginPct == null ? "—" : `${product.netMarginPct.toFixed(1)}%`}</strong>
          </div>
        ))}
        </div></div>
      </Card></div>
      {tip && <Tooltip {...tip} />}
    </div>
  );
}
