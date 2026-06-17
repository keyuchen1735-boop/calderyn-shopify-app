export type MetricKey = "aov" | "return_rate" | "gross_margin_pct" | "ship_cost_pct";

export interface PeerKpi {
  metric_key: MetricKey;
  label: string;
  unit: "USD" | "ratio";
  your_value: number | null; // the requesting shop's own value (never gated)
  p25: number | null;
  p50: number | null;
  p75: number | null;
  n: number | null;
  percentile: number | null; // 1..99, approximate standing in the peer band
  available: boolean; // consented && n >= 5
}

export interface PeerBenchmarks {
  niche: string; // 'cat:<category>' or 'cat:uncategorized'
  consented: boolean;
  kpis: PeerKpi[];
}

export const KPI_META: Record<MetricKey, { label: string; unit: "USD" | "ratio" }> = {
  aov: { label: "Average order value", unit: "USD" },
  return_rate: { label: "30-day return rate", unit: "ratio" },
  gross_margin_pct: { label: "Gross margin", unit: "ratio" },
  ship_cost_pct: { label: "Ship cost % of revenue", unit: "ratio" },
};

export const KPI_VIEW: Record<MetricKey, string> = {
  aov: "v_peer_kpi_aov",
  return_rate: "v_peer_kpi_return_rate",
  gross_margin_pct: "v_peer_kpi_gross_margin_pct",
  ship_cost_pct: "v_peer_kpi_ship_cost_pct",
};
