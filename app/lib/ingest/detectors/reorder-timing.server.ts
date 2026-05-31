import { getSupabase } from "../../supabase.server";

export type SkuFlat = {
  id: string;
  sku: string | null;
  title: string;
  on_hand: number;
  velocity: number;
  days_of_cover: number;
};

export type ReorderThreshold = {
  days_of_cover_lt: number;
  min_velocity: number;
  horizon_days: number;
};

export const DEFAULT_REORDER_THRESHOLD: ReorderThreshold = {
  days_of_cover_lt: 14,
  min_velocity: 0.1,
  horizon_days: 14,
};

export const DETECTOR_ID = "reorder_timing";

export type AlertDraft = {
  sku_id: string;
  entity_ref: { sku: string; sku_id: string; title: string };
  severity: "critical" | "high" | "medium";
  dollar_impact: number; // dollars (DB stores dollars)
  claude_rank: number;
  claude_narrative: string;
  evidence: Record<string, unknown>;
};

export function scoreReorderTiming(
  skus: SkuFlat[],
  avgSellPriceCents: Record<string, number>,
  threshold: ReorderThreshold,
  now: Date = new Date(),
): AlertDraft[] {
  const drafts: AlertDraft[] = skus
    .filter((s) => s.velocity >= threshold.min_velocity && s.days_of_cover < threshold.days_of_cover_lt)
    .map((s) => {
      const unmetUnits = Math.max(0, threshold.horizon_days - s.days_of_cover) * s.velocity;
      const priceCents = avgSellPriceCents[s.id] ?? 0;
      const dollarImpact = (unmetUnits * priceCents) / 100;
      const severity: AlertDraft["severity"] =
        s.days_of_cover < 3 ? "critical" : s.days_of_cover < 7 ? "high" : "medium";
      const stockoutDate = new Date(now.getTime() + s.days_of_cover * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const narrative =
        `${s.title} has ${s.days_of_cover} days of cover at ${s.velocity}/day and will stock out around ${stockoutDate}. ` +
        `Reorder now to avoid ~$${dollarImpact.toFixed(0)} in lost sales over the next ${threshold.horizon_days} days.`;
      return {
        sku_id: s.id,
        entity_ref: { sku: s.sku ?? s.id, sku_id: s.id, title: s.title },
        severity,
        dollar_impact: dollarImpact,
        claude_rank: 0,
        claude_narrative: narrative,
        evidence: {
          on_hand: s.on_hand,
          velocity: s.velocity,
          days_of_cover: s.days_of_cover,
          avg_sell_price_cents: priceCents,
          horizon_days: threshold.horizon_days,
          threshold,
        },
      };
    });

  drafts.sort((a, b) => b.dollar_impact - a.dollar_impact);
  drafts.forEach((d, i) => (d.claude_rank = i + 1));
  return drafts;
}

export type DetectorRunResult = { upserted: number; resolved: number };

export async function runReorderTimingDetector(shopId: string, now = new Date()): Promise<DetectorRunResult> {
  const sb = getSupabase();

  // 1. Threshold (per-shop row, else defaults)
  const { data: thr } = await sb
    .from("alert_thresholds")
    .select("threshold_json")
    .eq("shop_id", shopId)
    .eq("detector_id", DETECTOR_ID)
    .maybeSingle();
  const threshold: ReorderThreshold = { ...DEFAULT_REORDER_THRESHOLD, ...((thr?.threshold_json as Partial<ReorderThreshold>) ?? {}) };

  // 2. SKUs from the flat view
  const { data: skuRows, error: skuErr } = await sb
    .from("v_skus_flat")
    .select("id, sku, title, on_hand, velocity, days_of_cover")
    .eq("shop_id", shopId);
  if (skuErr) throw skuErr;
  const skus: SkuFlat[] = (skuRows ?? []).map((r) => ({
    id: String(r.id),
    sku: (r.sku as string | null) ?? null,
    title: String(r.title),
    on_hand: Number(r.on_hand ?? 0),
    velocity: Number(r.velocity ?? 0),
    days_of_cover: Number(r.days_of_cover ?? 0),
  }));

  // 3. Average sell price per sku (cents) from recent order lines
  const avg: Record<string, number> = {};
  const { data: lines } = await sb
    .from("order_line_fact")
    .select("sku_id, price_cents")
    .eq("shop_id", shopId)
    .not("sku_id", "is", null);
  const acc: Record<string, { sum: number; n: number }> = {};
  for (const l of lines ?? []) {
    const k = String(l.sku_id);
    acc[k] ??= { sum: 0, n: 0 };
    acc[k].sum += Number(l.price_cents ?? 0);
    acc[k].n += 1;
  }
  for (const [k, v] of Object.entries(acc)) avg[k] = v.n ? Math.round(v.sum / v.n) : 0;

  const drafts = scoreReorderTiming(skus, avg, threshold, now);
  const dayBucket = now.toISOString().slice(0, 10);
  const breachingSkuIds = new Set(drafts.map((d) => d.sku_id));

  // 4. Upsert each draft (idempotent on sku_id within the day)
  let upserted = 0;
  for (const d of drafts) {
    const { data: existing } = await sb
      .from("alerts")
      .select("id")
      .eq("shop_id", shopId)
      .eq("detector_id", DETECTOR_ID)
      .eq("day_bucket", dayBucket)
      .filter("entity_ref->>sku_id", "eq", d.sku_id)
      .maybeSingle();

    if (existing) {
      await sb
        .from("alerts")
        .update({
          severity: d.severity,
          dollar_impact: d.dollar_impact,
          claude_rank: d.claude_rank,
          claude_narrative: d.claude_narrative,
          entity_ref: d.entity_ref,
          status: "open",
          last_seen_at: now.toISOString(),
          resolved_at: null,
        })
        .eq("id", (existing as { id: string }).id);
      await sb.from("alert_context").upsert({ alert_id: (existing as { id: string }).id, shop_id: shopId, evidence: d.evidence, created_at: now.toISOString() }, { onConflict: "alert_id" });
    } else {
      // Upsert on the real unique constraint (shop_id, detector_id, entity_ref,
      // day_bucket) so a concurrent run (or retry) can't create a duplicate row
      // for the same sku/day — the DB enforces idempotency atomically.
      const { data: ins, error: insErr } = await sb
        .from("alerts")
        .upsert(
          {
            shop_id: shopId,
            detector_id: DETECTOR_ID,
            entity_ref: d.entity_ref,
            status: "open",
            severity: d.severity,
            dollar_impact: d.dollar_impact,
            day_bucket: dayBucket,
            claude_narrative: d.claude_narrative,
            claude_rank: d.claude_rank,
            first_seen_at: now.toISOString(),
            last_seen_at: now.toISOString(),
          },
          { onConflict: "shop_id,detector_id,entity_ref,day_bucket" },
        )
        .select("id")
        .single();
      if (insErr) throw insErr;
      await sb
        .from("alert_context")
        .upsert(
          { alert_id: (ins as { id: string }).id, shop_id: shopId, evidence: d.evidence, created_at: now.toISOString() },
          { onConflict: "alert_id" },
        );
    }
    upserted += 1;
  }

  // 5. Resolve open alerts whose sku no longer breaches
  const { data: openRows } = await sb
    .from("alerts")
    .select("id, entity_ref")
    .eq("shop_id", shopId)
    .eq("detector_id", DETECTOR_ID)
    .eq("status", "open");
  let resolved = 0;
  for (const r of openRows ?? []) {
    const skuId = (r.entity_ref as { sku_id?: string })?.sku_id;
    if (skuId && !breachingSkuIds.has(skuId)) {
      await sb.from("alerts").update({ status: "resolved", resolved_at: now.toISOString() }).eq("id", r.id);
      resolved += 1;
    }
  }

  return { upserted, resolved };
}
