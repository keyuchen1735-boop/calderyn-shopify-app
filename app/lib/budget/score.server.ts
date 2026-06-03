import type { MetaCampaign } from "../meta/campaigns.server";

// The per-campaign spend+ROAS reading this loop consumes. Named distinctly from
// the analytics `CampaignInsight` DTO (app/lib/types.ts) to avoid a same-name
// clash across modules. `fetchCampaignInsights` (Task 5) returns this exact
// shape; TypeScript matches it structurally.
export type CampaignSpendRoas = { spend7dCents: number; roas7d: number };

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
  insights: Record<string, CampaignSpendRoas>,
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

export function planCuts(classified: Classified[], cfg: BudgetConfig): BudgetMove[] {
  const moves: BudgetMove[] = [];
  for (const c of classified) {
    if (!isLoser(c.decision)) continue;
    const budget = c.campaign.dailyBudgetCents;
    const cut = Math.round(budget * cfg.stepPct);
    const toCents = Math.max(cfg.floorCents, budget - cut);
    const freed = budget - toCents;
    if (freed <= 0) continue;
    moves.push({
      campaignId: c.campaign.id,
      name: c.campaign.name,
      fromCents: budget,
      toCents,
      deltaCents: -freed,
      role: "cut",
      roas7d: c.campaign.roas7d,
    });
  }
  return moves;
}

export function planFeeds(
  classified: Classified[],
  realizedFreedCents: number,
  cfg: BudgetConfig,
): BudgetMove[] {
  const winners = classified
    .filter((c) => c.decision === "winner")
    .map((c) => c.campaign)
    .sort((a, b) => b.roas7d - a.roas7d);
  const moves: BudgetMove[] = [];
  let pool = realizedFreedCents;
  for (const w of winners) {
    if (pool <= 0) break;
    const cap = Math.round(w.dailyBudgetCents * cfg.ceilingPct);
    const add = Math.min(cap, pool);
    if (add <= 0) continue;
    moves.push({
      campaignId: w.id,
      name: w.name,
      fromCents: w.dailyBudgetCents,
      toCents: w.dailyBudgetCents + add,
      deltaCents: add,
      role: "feed",
      roas7d: w.roas7d,
    });
    pool -= add;
  }
  return moves;
}

export function scoreLosers(classified: Classified[], cfg: BudgetConfig): CampaignAlertDraft[] {
  const drafts: CampaignAlertDraft[] = [];
  for (const c of classified) {
    if (!isLoser(c.decision)) continue;
    const cam = c.campaign;
    const dollarImpact = (cam.spend7dCents / 100) * Math.max(0, 1 - cam.roas7d / cfg.targetRoas);
    const severity: "critical" | "high" = c.decision === "negative_unit_economics" ? "critical" : "high";
    const narrative =
      `${cam.name} is running at ${cam.roas7d.toFixed(2)} ROAS over 7 days against a ` +
      `${cfg.targetRoas.toFixed(2)} target on $${(cam.spend7dCents / 100).toFixed(0)} spend. ` +
      (c.decision === "negative_unit_economics"
        ? "It is returning less than it costs -- cut its budget."
        : "It is below breakeven -- cut its budget and shift it to a winner.");
    drafts.push({
      detectorId: c.decision,
      entity_ref: { campaign_id: cam.id, name: cam.name },
      severity,
      dollar_impact: dollarImpact,
      claude_rank: 0,
      claude_narrative: narrative,
      evidence: {
        roas7d: cam.roas7d,
        spend7d_cents: cam.spend7dCents,
        daily_budget_cents: cam.dailyBudgetCents,
        target_roas: cfg.targetRoas,
        decision: c.decision,
      },
    });
  }
  drafts.sort((a, b) => b.dollar_impact - a.dollar_impact);
  drafts.forEach((d, i) => (d.claude_rank = i + 1));
  return drafts;
}
