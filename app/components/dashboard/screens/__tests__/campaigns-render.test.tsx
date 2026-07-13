import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import Campaigns from "../Campaigns";
import type { DashboardCtx } from "../../context";
import type { CampaignVM } from "../../view-models";

const campaign: CampaignVM = {
  id: "campaign-1",
  name: "Summer essentials",
  platform: "Meta",
  status: "active",
  daily_budget_cents: 4500,
  spend_7d: 31500,
  roas_7d: 2.4,
  breakeven_roas: 1.6,
  contribution_margin: 0,
  grade: "winning",
  calderynScore: {
    value: 82,
    band: "strong",
    performance: 86,
    creative: 76,
    confidence: "high",
    weakDimensions: [],
    tips: [],
    adsCovered: 3,
    adsTotal: 3,
  },
};

function context(param: string | null, campaigns: CampaignVM[] = []): DashboardCtx {
  return {
    nav: { screen: "campaigns", param, sub: null },
    campaigns,
    loading: false,
    storeLabel: "Northstar Goods",
    navigate: vi.fn(),
    refresh: vi.fn(),
    toast: vi.fn(),
  } as unknown as DashboardCtx;
}

describe("Campaigns experience server render", () => {
  it("renders the production campaign wizard without unrelated analytics placeholders", () => {
    const html = renderToStaticMarkup(<Campaigns app={context("new")} />);

    expect(html).toContain("Which platform?");
    expect(html).toContain("Pick where your first ad runs.");
    expect(html).toContain("Continue");
    expect(html).toContain("Skip — I know what I&#x27;m doing");
    expect(html).not.toContain("Sessions by channel");
  });

  it("renders the portfolio briefing and campaign poster", () => {
    const html = renderToStaticMarkup(<Campaigns app={context(null, [campaign])} />);

    expect(html).toContain("Your campaign briefing");
    expect(html).toContain("Campaign library");
    expect(html).toContain("Summer essentials");
    expect(html).toContain("Returning 0.8× above break-even.");
  });

  it("renders the performance story with a distinct loading state", () => {
    const html = renderToStaticMarkup(<Campaigns app={context(campaign.id, [campaign])} />);

    expect(html).toContain("Your next move");
    expect(html).toContain("Current 2.4×");
    expect(html).toContain("Spend vs revenue · loading");
    expect(html).toContain("No history yet — data appears after the first day of spend");
  });
});
