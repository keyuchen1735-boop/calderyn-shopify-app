import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc }) }));

describe("replaceSellingPlanSnapshot", () => {
  beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ data: { groups: 1, plans: 1, eligibility: 1 }, error: null }); });

  it("sends one canonical shop-scoped provider snapshot and is retry-idempotent", async () => {
    const { replaceSellingPlanSnapshot } = await import("./selling-plan-sync.server");
    const snapshot = {
      groups: [{ externalId: "g-1", name: "Subscribe" }],
      plans: [{ externalId: "p-1", groupExternalId: "g-1", name: "Monthly", cadence: "Every month" }],
      eligibility: [{ variantExternalId: "v-1", planExternalId: "p-1", priceCents: 900, currency: "USD" }],
    };
    await replaceSellingPlanSnapshot("shop-a", "shopify", snapshot);
    await replaceSellingPlanSnapshot("shop-a", "shopify", snapshot);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc).toHaveBeenCalledWith("replace_selling_plan_snapshot", {
      p_shop_id: "shop-a", p_provider: "shopify",
      p_groups: [{ external_id: "g-1", name: "Subscribe" }],
      p_plans: [{ external_id: "p-1", group_external_id: "g-1", name: "Monthly", cadence: "Every month" }],
      p_eligibility: [{ variant_external_id: "v-1", plan_external_id: "p-1", price_cents: 900, currency: "USD" }],
    });
  });

  it("fails before mutation for cross-reference errors", async () => {
    const { replaceSellingPlanSnapshot } = await import("./selling-plan-sync.server");
    await expect(replaceSellingPlanSnapshot("shop-a", "shopify", {
      groups: [], plans: [], eligibility: [{ variantExternalId: "v-1", planExternalId: "foreign" }],
    })).rejects.toThrow(/plan/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps tenant identity isolated in otherwise identical snapshots", async () => {
    const { replaceSellingPlanSnapshot } = await import("./selling-plan-sync.server");
    const snapshot = {
      groups: [{ externalId: "g-1", name: "Subscribe" }],
      plans: [{ externalId: "p-1", groupExternalId: "g-1", name: "Monthly", cadence: "Every month" }],
      eligibility: [{ variantExternalId: "v-1", planExternalId: "p-1" }],
    };
    await replaceSellingPlanSnapshot("shop-a", "shopify", snapshot);
    await replaceSellingPlanSnapshot("shop-b", "shopify", snapshot);
    expect(rpc.mock.calls[0][1].p_shop_id).toBe("shop-a");
    expect(rpc.mock.calls[1][1].p_shop_id).toBe("shop-b");
  });

  it("surfaces atomic repository errors without a cleanup fallback", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "stale delete failed after upsert" } });
    const { replaceSellingPlanSnapshot } = await import("./selling-plan-sync.server");
    await expect(replaceSellingPlanSnapshot("shop-a", "shopify", { groups: [], plans: [], eligibility: [] }))
      .rejects.toThrow(/stale delete failed after upsert/);
    expect(rpc).toHaveBeenCalledOnce();
  });
});
