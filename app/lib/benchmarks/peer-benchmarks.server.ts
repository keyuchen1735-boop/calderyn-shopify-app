import { getSupabase, resolveShopId } from "../supabase.server";
import {
  KPI_META,
  KPI_VIEW,
  type MetricKey,
  type PeerBenchmarks,
  type PeerKpi,
} from "./types";

const K_FLOOR = 5;
const METRIC_KEYS = Object.keys(KPI_META) as MetricKey[];

/** Approximate standing in the peer band, piecewise-linear across the
 * quartiles, clamped to 1..99. "Approximate" per spec — no p0/p100 known. */
function percentileFromQuartiles(v: number, p25: number, p50: number, p75: number): number {
  const EPS = 1e-9;
  let pct: number;
  if (v <= p25) pct = p25 > 0 ? 25 * (v / p25) : 25;
  else if (v <= p50) pct = 25 + (25 * (v - p25)) / Math.max(p50 - p25, EPS);
  else if (v <= p75) pct = 50 + (25 * (v - p50)) / Math.max(p75 - p50, EPS);
  else pct = 75 + (25 * (v - p75)) / Math.max(p75 - p50, EPS);
  return Math.round(Math.min(99, Math.max(1, pct)));
}

export async function getPeerBenchmarks(shop: string): Promise<PeerBenchmarks> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);

  const [{ data: shopRow }, { data: nicheRow }] = await Promise.all([
    sb.from("shops").select("peer_data_consent").eq("id", shopId).maybeSingle(),
    sb.from("v_peer_shop_niche").select("segment").eq("shop_id", shopId).maybeSingle(),
  ]);

  const consented = Boolean(shopRow?.peer_data_consent);
  const niche: string = nicheRow?.segment ?? "cat:uncategorized";

  // Own values from the shared KPI views (never gated).
  const ownValues = new Map<MetricKey, number | null>();
  await Promise.all(
    METRIC_KEYS.map(async (key) => {
      const { data } = await sb
        .from(KPI_VIEW[key])
        .select("value")
        .eq("shop_id", shopId)
        .maybeSingle();
      ownValues.set(key, data?.value ?? null);
    }),
  );

  // Peer baselines for this niche (skip the query if it can't be available).
  const baselines = new Map<MetricKey, { p25: number; p50: number; p75: number; n: number }>();
  if (consented && niche !== "cat:uncategorized") {
    const { data } = await sb
      .from("v_peer_metric_baselines")
      .select("metric_key, p25, p50, p75, n")
      .eq("segment", niche);
    for (const row of data ?? []) {
      baselines.set(row.metric_key as MetricKey, {
        p25: Number(row.p25),
        p50: Number(row.p50),
        p75: Number(row.p75),
        n: Number(row.n),
      });
    }
  }

  const kpis: PeerKpi[] = METRIC_KEYS.map((key) => {
    const your = ownValues.get(key) ?? null;
    const base = baselines.get(key);
    const available = consented && !!base && base.n >= K_FLOOR;
    return {
      metric_key: key,
      label: KPI_META[key].label,
      unit: KPI_META[key].unit,
      your_value: your === null ? null : Number(your),
      p25: available ? base!.p25 : null,
      p50: available ? base!.p50 : null,
      p75: available ? base!.p75 : null,
      n: available ? base!.n : null,
      percentile:
        available && your !== null
          ? percentileFromQuartiles(Number(your), base!.p25, base!.p50, base!.p75)
          : null,
      available,
    };
  });

  return { niche, consented, kpis };
}
