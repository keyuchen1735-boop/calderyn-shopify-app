import {
  classify,
  planCuts,
  planFeeds,
  scoreLosers,
  toPerf,
  isLoser,
  type BudgetConfig,
  type BudgetMove,
  type CampaignAlertDraft,
  type CampaignSpendRoas,
} from "./score.server";
import { gateMove, type GateStatic } from "./guardrails.server";
import type { MetaCampaign } from "../meta/campaigns.server";

export type GatedMove = BudgetMove & { decision: "execute" | "block"; reason: string };

export type TickPlan = {
  cuts: GatedMove[];
  feeds: GatedMove[];
  loserAlerts: CampaignAlertDraft[];
  breachingCampaignIds: string[];
};

export function planTick(
  campaigns: MetaCampaign[],
  insights: Record<string, CampaignSpendRoas>,
  cfg: BudgetConfig,
  gate: GateStatic,
  usedTodayCents0: number,
): TickPlan {
  const classified = classify(toPerf(campaigns, insights), cfg);
  const loserAlerts = scoreLosers(classified, cfg);
  const breachingCampaignIds = classified.filter((c) => isLoser(c.decision)).map((c) => c.campaign.id);

  let used = usedTodayCents0;
  let realizedFreed = 0;
  const cuts: GatedMove[] = planCuts(classified, cfg).map((m) => {
    const g = gateMove(m, used, gate);
    if (g.decision === "execute") {
      used += Math.abs(m.deltaCents);
      realizedFreed += Math.abs(m.deltaCents);
    }
    return { ...m, ...g };
  });

  const feeds: GatedMove[] = planFeeds(classified, realizedFreed, cfg).map((m) => {
    const g = gateMove(m, used, gate);
    if (g.decision === "execute") used += Math.abs(m.deltaCents);
    return { ...m, ...g };
  });

  return { cuts, feeds, loserAlerts, breachingCampaignIds };
}
