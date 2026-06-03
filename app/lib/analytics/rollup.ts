import type {
  AnalyticsSummary,
  CampaignInsight,
  Engagement,
  MarginConfidence,
  TrendPoint,
} from "~/lib/types";
import { gradeCampaign } from "./classify";

export interface CampaignDailyRow {
  campaign_external_id: string;
  campaign_name: string;
  day_bucket: string;
  spend_cents: number;
  impressions: number;
  link_clicks: number;
  purchases: number;
  purchase_value_cents: number;
}

export interface AdDailyRow {
  campaign_external_id: string;
  ad_external_id: string;
  ad_name: string;
  day_bucket: string;
  spend_cents: number;
  purchase_value_cents: number;
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
  post_engagement: number;
}

const roas = (value: number, spend: number) => (spend > 0 ? value / spend : 0);

export function rollupTrend(rows: CampaignDailyRow[]): TrendPoint[] {
  const byDay = new Map<string, { spend: number; value: number }>();
  for (const r of rows) {
    const cur = byDay.get(r.day_bucket) ?? { spend: 0, value: 0 };
    cur.spend += r.spend_cents;
    cur.value += r.purchase_value_cents;
    byDay.set(r.day_bucket, cur);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day_bucket, v]) => ({ day_bucket, spend_cents: v.spend, roas: roas(v.value, v.spend) }));
}

function sumEngagement(rows: AdDailyRow[]): Engagement {
  return rows.reduce<Engagement>(
    (e, r) => ({
      reactions: e.reactions + r.reactions,
      comments: e.comments + r.comments,
      shares: e.shares + r.shares,
      saves: e.saves + r.saves,
      post_engagement: e.post_engagement + r.post_engagement,
    }),
    { reactions: 0, comments: 0, shares: 0, saves: 0, post_engagement: 0 },
  );
}

export function rollupSummary(
  camp: CampaignDailyRow[],
  ads: AdDailyRow[],
  opts: { breakEvenRoas: number; marginPct: number; confidence: MarginConfidence; windowDays: 7 | 30 | 90 },
): AnalyticsSummary {
  const spend = camp.reduce((s, r) => s + r.spend_cents, 0);
  const value = camp.reduce((s, r) => s + r.purchase_value_cents, 0);
  const eng = sumEngagement(ads);
  return {
    window_days: opts.windowDays,
    blended_margin_pct: opts.marginPct,
    margin_confidence: opts.confidence,
    break_even_roas: opts.breakEvenRoas,
    account_roas: roas(value, spend),
    total_spend_cents: spend,
    total_engagement: eng.reactions + eng.comments + eng.shares + eng.saves,
  };
}

export function rollupCampaigns(
  camp: CampaignDailyRow[],
  ads: AdDailyRow[],
  breakEvenRoas: number,
  linkedAlerts: Record<string, string[]>,
): CampaignInsight[] {
  const engByCampaign = new Map<string, AdDailyRow[]>();
  for (const a of ads) {
    const list = engByCampaign.get(a.campaign_external_id) ?? [];
    list.push(a);
    engByCampaign.set(a.campaign_external_id, list);
  }

  const byCampaign = new Map<string, CampaignInsight>();
  for (const r of camp) {
    const cur =
      byCampaign.get(r.campaign_external_id) ??
      ({
        campaign_id: r.campaign_external_id,
        name: r.campaign_name ?? "",
        status: "active",
        spend_cents: 0,
        impressions: 0,
        link_clicks: 0,
        purchases: 0,
        purchase_value_cents: 0,
        roas: 0,
        break_even_roas: breakEvenRoas,
        grade: "poor",
        engagement: sumEngagement(engByCampaign.get(r.campaign_external_id) ?? []),
        linked_alert_ids: linkedAlerts[r.campaign_external_id] ?? [],
      } satisfies CampaignInsight);
    cur.spend_cents += r.spend_cents;
    cur.impressions += r.impressions;
    cur.link_clicks += r.link_clicks;
    cur.purchases += r.purchases;
    cur.purchase_value_cents += r.purchase_value_cents;
    byCampaign.set(r.campaign_external_id, cur);
  }

  return [...byCampaign.values()]
    .map((c) => {
      const r = roas(c.purchase_value_cents, c.spend_cents);
      return { ...c, roas: r, grade: gradeCampaign(r, breakEvenRoas) };
    })
    .sort((a, b) => b.spend_cents - a.spend_cents);
}
