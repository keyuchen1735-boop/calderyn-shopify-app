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
