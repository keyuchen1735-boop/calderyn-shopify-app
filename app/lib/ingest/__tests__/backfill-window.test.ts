import { describe, it, expect, vi } from "vitest";

const fetchRecentOrders = vi.fn(async function* () {});
vi.mock("../shopify-admin.server", () => ({
  fetchLocations: vi.fn(async () => []),
  fetchProducts: vi.fn(async function* () {}),
  fetchRecentOrders,
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      upsert: () => ({ select: () => Promise.resolve({ data: [], error: null }) }),
      update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }),
  }),
  resolveShopId: vi.fn(async () => "shop1"),
}));

describe("backfillShop window", () => {
  it("defaults the orders since-window to 30 days", async () => {
    const { backfillShop } = await import("../backfill.server");
    await backfillShop("d.myshopify.com");
    const since = new Date(fetchRecentOrders.mock.calls[0][1] as string).getTime();
    const days = (Date.now() - since) / 86_400_000;
    expect(days).toBeGreaterThan(28);
    expect(days).toBeLessThan(32);
  });

  it("passes a 365-day-ago since when sinceDays=365", async () => {
    fetchRecentOrders.mockClear();
    const { backfillShop } = await import("../backfill.server");
    await backfillShop("d.myshopify.com", { sinceDays: 365 });
    const since = new Date(fetchRecentOrders.mock.calls[0][1] as string).getTime();
    const days = (Date.now() - since) / 86_400_000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
  });
});
