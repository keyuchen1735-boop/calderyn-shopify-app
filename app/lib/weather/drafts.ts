import type { RegionCode } from "../ads/actions";

export interface WeatherAlertDraft {
  entityRef: Record<string, unknown>;
  severity: "low" | "medium" | "high" | "critical";
  dollarImpact: number;
  rank: number;
  narrative: string;
  evidence: Record<string, unknown>;
}

export function budgetDraft(a: {
  sourceCampaignId: string; destCampaignId: string; sourceName: string; destName: string;
  amountCents: number; sourceRegion: RegionCode; destRegion: RegionCode;
  sourceScore: number; destScore: number; narrative: string;
}): WeatherAlertDraft {
  return {
    entityRef: { campaign_id: a.sourceCampaignId, title: `Shift budget to ${a.destName}` },
    severity: "medium",
    dollarImpact: Math.round(a.amountCents / 100),
    rank: 50,
    narrative: a.narrative,
    evidence: {
      source_campaign_id: a.sourceCampaignId,
      dest_campaign_id: a.destCampaignId,
      amount_cents: a.amountCents,
      source_region: a.sourceRegion,
      dest_region: a.destRegion,
      source_score: a.sourceScore,
      dest_score: a.destScore,
    },
  };
}
