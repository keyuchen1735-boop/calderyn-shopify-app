// Pure assembly of a campaign's REAL performance for the detail view.
//
// The detail loader sources a campaign two ways: the ingested path returns a
// populated v_campaigns_flat row (spend/ROAS/margin), while the live-platform
// path may have no ingested metrics yet. Per rule 12 (fail visibly, never fake
// success), a missing row yields `available: false` with null metrics — the UI
// renders "— no data", NOT a misleading 0× ROAS / $0 spend.

import type { Campaign } from "~/lib/types";

export interface CampaignPerformance {
  available: boolean;
  spend7dCents: number | null;
  reportedRoas: number | null;
  /** Margin-adjusted ROAS — reported ROAS after product costs (roas × margin). */
  realRoas: number | null;
  contributionMargin: number | null;
  dailyBudgetCents: number | null;
}

export function buildCampaignPerformance(campaign: Campaign | null): CampaignPerformance {
  const hasMetrics =
    campaign != null && campaign.roas_7d > 0 && campaign.contribution_margin > 0;
  if (!campaign || !hasMetrics) {
    return {
      available: false,
      spend7dCents: campaign && campaign.spend_7d > 0 ? campaign.spend_7d : null,
      reportedRoas: null,
      realRoas: null,
      contributionMargin: null,
      dailyBudgetCents: campaign ? campaign.daily_budget_cents : null,
    };
  }
  return {
    available: true,
    spend7dCents: campaign.spend_7d,
    reportedRoas: campaign.roas_7d,
    realRoas: campaign.roas_7d * campaign.contribution_margin,
    contributionMargin: campaign.contribution_margin,
    dailyBudgetCents: campaign.daily_budget_cents,
  };
}
