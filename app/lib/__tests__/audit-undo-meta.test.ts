import { describe, it, expect, vi, beforeEach } from "vitest";
import { calderynClient } from "../calderyn.server";

// Spies for the IO boundaries we mock. vi.hoisted runs before the (hoisted)
// vi.mock factories that reference these. The real audit.undo logic runs.
const { insertSpy, setStatusSpy, metaForShopSpy } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  setStatusSpy: vi.fn(),
  metaForShopSpy: vi.fn(),
}));

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      // orig select: .select("*").eq("shop_id").eq("id").maybeSingle()
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: "a1",
                action_kind: "pause_campaign",
                pre_state: { status: "ACTIVE" },
                post_state: { campaign_id: "120" },
                alert_id: null,
                params: {},
                dollar_impact_at_exec: 0,
              },
              error: null,
            }),
          }),
        }),
      }),
      // inverse insert — should NOT be reached when the Meta restore fails
      insert: insertSpy,
    }),
  }),
  resolveShopId: async () => "shop-uuid",
}));

vi.mock("../meta/client.server", () => ({
  metaClientForShop: (...args: unknown[]) => metaForShopSpy(...args),
}));

vi.mock("../meta/campaigns.server", () => ({
  setCampaignStatus: (...args: unknown[]) => setStatusSpy(...args),
}));

beforeEach(() => {
  insertSpy.mockReset();
  setStatusSpy.mockReset();
  metaForShopSpy.mockReset();
});

describe("audit.undo Meta safety", () => {
  it("does NOT write an inverse audit row when the Meta restore call fails", async () => {
    metaForShopSpy.mockResolvedValue({ client: { get: vi.fn(), post: vi.fn() }, adAccountId: "act_1" });
    setStatusSpy.mockRejectedValue(new Error("Meta API error: Permission denied"));

    const client = calderynClient("acme.myshopify.com");

    await expect(client.audit.undo("a1")).rejects.toThrow(/Permission denied/);
    // The prior status was restore-attempted before any DB write...
    expect(setStatusSpy).toHaveBeenCalledWith(expect.anything(), "120", "ACTIVE");
    // ...and because it threw, the inverse row was never inserted.
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
