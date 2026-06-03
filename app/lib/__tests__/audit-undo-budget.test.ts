import { describe, it, expect, vi, beforeEach } from "vitest";
import { calderynClient } from "../calderyn.server";

const { insertSpy, setBudgetSpy, metaForShopSpy } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  setBudgetSpy: vi.fn(),
  metaForShopSpy: vi.fn(),
}));

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "a1",
                action_kind: "reduce_campaign_budget",
                pre_state: { campaign_id: "120", daily_budget_cents: 5000 },
                post_state: { campaign_id: "120", daily_budget_cents: 4000 },
                alert_id: null,
                params: {},
                dollar_impact_at_exec: 10,
              },
              error: null,
            }),
          }),
        }),
      }),
      insert: insertSpy,
    }),
  }),
  resolveShopId: async () => "shop-uuid",
}));

vi.mock("../meta/client.server", () => ({
  metaClientForShop: (...args: unknown[]) => metaForShopSpy(...args),
}));

vi.mock("../meta/campaigns.server", () => ({
  setCampaignStatus: vi.fn(),
  setCampaignBudget: (...args: unknown[]) => setBudgetSpy(...args),
}));

beforeEach(() => {
  insertSpy.mockReset();
  setBudgetSpy.mockReset();
  metaForShopSpy.mockReset();
});

describe("audit.undo budget safety", () => {
  it("restores the prior daily_budget and writes no inverse row when Meta fails", async () => {
    metaForShopSpy.mockResolvedValue({ client: { get: vi.fn(), post: vi.fn() }, adAccountId: "act_1" });
    setBudgetSpy.mockRejectedValue(new Error("Meta API error: Cannot set budget"));

    const client = calderynClient("acme.myshopify.com");

    await expect(client.audit.undo("a1")).rejects.toThrow(/Cannot set budget/);
    expect(setBudgetSpy).toHaveBeenCalledWith(expect.anything(), "120", 5000);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
