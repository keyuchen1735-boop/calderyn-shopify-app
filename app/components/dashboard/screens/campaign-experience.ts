import type { CampaignVM } from "../view-models";

export type CampaignHealth = "paused" | "learning" | "attention" | "healthy";

export interface CampaignStory {
  health: CampaignHealth;
  eyebrow: string;
  verdict: string;
  detail: string;
  roasDelta: number | null;
}

export interface CampaignPortfolio {
  activeCount: number;
  pausedCount: number;
  healthyCount: number;
  attentionCount: number;
  learningCount: number;
  dailyBudgetCents: number;
}

/** Turns the same real ROAS and break-even values shown in the UI into a short,
 * deterministic reading. Zero-spend campaigns stay in learning instead of
 * being labelled as losers. */
export function campaignStory(campaign: CampaignVM): CampaignStory {
  if (campaign.status === "paused") {
    return {
      health: "paused",
      eyebrow: "Paused",
      verdict: "This campaign is resting.",
      detail: "Resume it when you are ready to collect fresh performance data.",
      roasDelta: campaign.spend_7d > 0 ? campaign.roas_7d - campaign.breakeven_roas : null,
    };
  }

  if (campaign.spend_7d <= 0) {
    return {
      health: "learning",
      eyebrow: "Gathering signal",
      verdict: "The first chapter is still being written.",
      detail: "Performance will become clearer after spend and attributed sales arrive.",
      roasDelta: null,
    };
  }

  const delta = Math.round((campaign.roas_7d - campaign.breakeven_roas) * 10) / 10;
  if (delta < 0) {
    return {
      health: "attention",
      eyebrow: "Needs a closer look",
      verdict: `Returning ${Math.abs(delta).toFixed(1)}× below break-even.`,
      detail: "Review the creative and budget before giving this campaign more room.",
      roasDelta: delta,
    };
  }

  return {
    health: "healthy",
    eyebrow: "In a good rhythm",
    verdict: `Returning ${delta.toFixed(1)}× above break-even.`,
    detail: "The current return is clearing the campaign's profitability threshold.",
    roasDelta: delta,
  };
}

/** Account-level facts for the campaigns masthead. Paused budgets are excluded
 * because they are not currently spending. */
export function campaignPortfolio(campaigns: CampaignVM[]): CampaignPortfolio {
  return campaigns.reduce<CampaignPortfolio>(
    (summary, campaign) => {
      const story = campaignStory(campaign);
      if (story.health === "paused") summary.pausedCount += 1;
      else summary.activeCount += 1;
      if (story.health === "healthy") summary.healthyCount += 1;
      if (story.health === "attention") summary.attentionCount += 1;
      if (story.health === "learning") summary.learningCount += 1;

      if (story.health !== "paused") {
        summary.dailyBudgetCents +=
          campaign.daily_budget_cents > 0
            ? campaign.daily_budget_cents
            : campaign.spend_7d > 0
              ? Math.round(campaign.spend_7d / 7)
              : 0;
      }
      return summary;
    },
    {
      activeCount: 0,
      pausedCount: 0,
      healthyCount: 0,
      attentionCount: 0,
      learningCount: 0,
      dailyBudgetCents: 0,
    },
  );
}

export function portfolioGreeting(summary: CampaignPortfolio): {
  title: string;
  detail: string;
} {
  if (summary.activeCount === 0) {
    return {
      title: "A fresh page for your next campaign.",
      detail: "Create a draft or connect an ad account to bring your campaign story together.",
    };
  }
  if (summary.attentionCount > 0) {
    return {
      title: `${summary.attentionCount} ${summary.attentionCount === 1 ? "campaign deserves" : "campaigns deserve"} a closer look.`,
      detail: "Start with the campaign below break-even, then work back toward the healthy set.",
    };
  }
  if (summary.learningCount > 0) {
    return {
      title: "Your live campaigns are finding their rhythm.",
      detail: "Some are still gathering signal; the rest are currently clearing break-even.",
    };
  }
  return {
    title: "Your campaign portfolio is in a good rhythm.",
    detail: "Every campaign with spend is currently clearing its break-even return.",
  };
}

export function roasRailPosition(value: number, breakEven: number): number {
  const max = Math.max(1, value, breakEven) * 1.35;
  return Math.max(4, Math.min(96, (value / max) * 100));
}
