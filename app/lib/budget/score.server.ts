import type { MetaCampaign } from "../meta/campaigns.server";

// Defined here (not imported from meta) so this module typechecks standalone at
// this task's commit. `fetchCampaignInsights` (Task 5) returns this exact shape;
// TypeScript matches it structurally.
export type CampaignInsight = { spend7dCents: number; roas7d: number };

export type CampaignPerf = {
  id: string;
  name: string;
  status: string;
  dailyBudgetCents: number;
  hasCampaignBudget: boolean;
  spend7dCents: number;
  roas7d: number;
};

export type BudgetConfig = {
  targetRoas: number;
  loseBand: number;
  winBand: number;
  stepPct: number;
  floorCents: number;
  ceilingPct: number;
  minSpend7dCents: number;
};

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  targetRoas: 2.0,
  loseBand: 0.9,
  winBand: 1.2,
  stepPct: 0.2,
  floorCents: 500,
  ceilingPct: 0.2,
  minSpend7dCents: 2000,
};

export type LoserDetectorId = "negative_unit_economics" | "campaign_below_breakeven";
export type Decision = LoserDetectorId | "winner" | "hold" | "skip";

export type Classified = { campaign: CampaignPerf; decision: Decision };

export type BudgetMove = {
  campaignId: string;
  name: string;
  fromCents: number;
  toCents: number;
  deltaCents: number; // negative = cut, positive = feed
  role: "cut" | "feed";
  roas7d: number;
};

export type CampaignAlertDraft = {
  detectorId: LoserDetectorId;
  entity_ref: { campaign_id: string; name: string };
  severity: "critical" | "high";
  dollar_impact: number;
  claude_rank: number;
  claude_narrative: string;
  evidence: Record<string, unknown>;
};

export function isLoser(d: Decision): d is LoserDetectorId {
  return d === "negative_unit_economics" || d === "campaign_below_breakeven";
}

export function toPerf(
  campaigns: MetaCampaign[],
  insights: Record<string, CampaignInsight>,
): CampaignPerf[] {
  return campaigns.map((c) => {
    const ins = insights[c.id] ?? { spend7dCents: 0, roas7d: 0 };
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      dailyBudgetCents: c.dailyBudgetCents ?? 0,
      hasCampaignBudget: c.dailyBudgetCents != null,
      spend7dCents: ins.spend7dCents,
      roas7d: ins.roas7d,
    };
  });
}

export function classify(perf: CampaignPerf[], cfg: BudgetConfig): Classified[] {
  return perf.map((c) => {
    if (c.status !== "ACTIVE" || !c.hasCampaignBudget || c.spend7dCents < cfg.minSpend7dCents) {
      return { campaign: c, decision: "skip" as const };
    }
    let decision: Decision;
    if (c.roas7d < 1.0) decision = "negative_unit_economics";
    else if (c.roas7d < cfg.targetRoas * cfg.loseBand) decision = "campaign_below_breakeven";
    else if (c.roas7d > cfg.targetRoas * cfg.winBand) decision = "winner";
    else decision = "hold";
    return { campaign: c, decision };
  });
}
