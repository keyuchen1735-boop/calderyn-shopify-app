import { describe, it, expect, vi } from "vitest";

// All vi.mock calls are hoisted above imports by vitest — they must appear before
// the route import below. Spies are declared via vi.hoisted so mock factories can
// close over them.
const { resolveCampaignDirectionMock } = vi.hoisted(() => ({
  resolveCampaignDirectionMock: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: async () => ({
    shopId: "shop-1",
    shopDomain: "acme.myshopify.com",
    sessionId: "sess-1",
  }),
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    campaigns: {
      get: async () => ({
        id: "cmp-1",
        roas_7d: 2,
        contribution_margin: 0.4,
        status: "active",
        daily_budget_cents: 10000,
        name: "C",
        platform: "Meta",
        spend_7d: 5000,
      }),
    },
    alerts: {
      list: async () => [],
    },
    guardrails: {
      get: async () => ({
        autopilot_max_budget_increase_pct: 20,
        autopilot_max_budget_cut_pct: 50,
        autopilot_max_daily_budget_cents: null,
      }),
    },
  }),
}));

vi.mock("~/lib/actions/direction-reason.server", () => ({
  resolveCampaignDirection: resolveCampaignDirectionMock,
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({}),
}));

import { loader } from "../dashboard.api.campaigns.$id.direction";

describe("dashboard direction endpoint — GET /dashboard/api/campaigns/:id/direction", () => {
  it("returns direction payload and calls resolveCampaignDirection with correct args", async () => {
    const fixture = {
      direction: "scale_up" as const,
      actionKind: "increase_campaign_budget" as const,
      suggestedBudgetCents: 12000,
      reason: "Winner with room.",
      reasonSource: "claude" as const,
      dataSufficient: true,
    };
    resolveCampaignDirectionMock.mockResolvedValue(fixture);

    const res = await loader({
      request: new Request("https://x/dashboard/api/campaigns/cmp-1/direction"),
      params: { id: "cmp-1" },
      context: {},
    } as never);

    const body = (await res.json()) as typeof fixture;

    expect(body).toMatchObject({ direction: "scale_up", suggestedBudgetCents: 12000 });
    expect(resolveCampaignDirectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: "shop-1",
        campaignId: "cmp-1",
        breakEvenRoas: 2.5,
      }),
    );
  });
});
