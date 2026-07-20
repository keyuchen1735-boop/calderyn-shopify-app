import type { CampaignVM } from "../view-models";
import type { CampaignWindow } from "~/lib/types";

export type CampaignFilter = "all" | "sales" | "regular";

const STORAGE_KEY = "calderyn:campaign-window";

type CampaignWindowStorage = Pick<Storage, "getItem" | "setItem">;

export function filterCampaigns(
  campaigns: CampaignVM[],
  filter: CampaignFilter,
): CampaignVM[] {
  return filter === "all"
    ? campaigns
    : campaigns.filter((campaign) => campaign.campaign_kind === filter);
}

export function summarizeCampaigns(campaigns: CampaignVM[]) {
  let profitCents = 0;
  let hasProfit = false;
  let costComplete = true;
  let spendCents = 0;
  let revenueCents = 0;
  let orders = 0;

  for (const campaign of campaigns) {
    orders += campaign.orders;
    revenueCents += campaign.revenue_cents;
    spendCents += campaign.spend_cents;
    costComplete &&= campaign.cost_complete;
    if (campaign.profit_cents != null) {
      hasProfit = true;
      profitCents += campaign.profit_cents;
    }
  }

  return {
    orders,
    revenueCents,
    profitCents: hasProfit ? profitCents : null,
    trueRoas: spendCents > 0 ? revenueCents / spendCents : null,
    costComplete,
  };
}

export function readCampaignWindow(
  storage?: Pick<CampaignWindowStorage, "getItem">,
): CampaignWindow {
  try {
    const value = Number(storage?.getItem(STORAGE_KEY));
    return value === 7 || value === 30 || value === 90 ? value : 30;
  } catch {
    return 30;
  }
}

export function writeCampaignWindow(
  storage: Pick<CampaignWindowStorage, "setItem">,
  window: CampaignWindow,
): void {
  try {
    storage.setItem(STORAGE_KEY, String(window));
  } catch {
    // Storage can be unavailable in privacy modes; the in-memory selection remains valid.
  }
}

export function missingCampaignCostLabels(costSources: string[]): string[] {
  const labels: string[] = [];
  if (costSources.includes("missing:cogs")) labels.push("product costs");
  if (costSources.includes("missing:carrier")) labels.push("carrier cost");
  return labels;
}
