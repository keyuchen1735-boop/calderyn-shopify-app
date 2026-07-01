import { describe, it, expect, vi, beforeEach } from "vitest";

const single = vi.fn();
const maybeSingle = vi.fn();
const insertMembership = vi.fn().mockResolvedValue({ error: null });
const seedSpy = vi.fn().mockResolvedValue(undefined);

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "membership") {
        return {
          insert: insertMembership,
          select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle }) }) }) }),
        };
      }
      // shops
      return { insert: () => ({ select: () => ({ single }) }) };
    },
  }),
  seedShippedAutopilotFeatures: seedSpy,
}));

beforeEach(() => {
  single.mockReset();
  maybeSingle.mockReset();
  insertMembership.mockClear();
  seedSpy.mockClear();
});

describe("owned-tenant helpers", () => {
  it("slugify produces a url-safe slug with a suffix", async () => {
    const { slugify } = await import("../tenant.server");
    expect(slugify("Acme Goods!")).toMatch(/^acme-goods-[a-z0-9]{6}$/);
  });

  it("provisionOwnedShop inserts a shop and seeds autopilot features", async () => {
    single.mockResolvedValue({ data: { id: "shop1", org_slug: "acme-abc123" }, error: null });
    const { provisionOwnedShop } = await import("../tenant.server");
    const res = await provisionOwnedShop("Acme");
    expect(res.shopId).toBe("shop1");
    expect(seedSpy).toHaveBeenCalledWith("shop1", expect.anything());
  });

  it("provisionOwnedShop retries once on 23505 slug collision then succeeds", async () => {
    single
      .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "duplicate key value" } })
      .mockResolvedValueOnce({ data: { id: "shop2", org_slug: "acme-retry" }, error: null });
    const { provisionOwnedShop } = await import("../tenant.server");
    const res = await provisionOwnedShop("Acme");
    expect(res.shopId).toBe("shop2");
    expect(single).toHaveBeenCalledTimes(2);
  });

  it("provisionOwnedShop does not retry on a non-23505 error", async () => {
    const dbError = { code: "42501", message: "permission denied" };
    single.mockResolvedValueOnce({ data: null, error: dbError });
    const { provisionOwnedShop } = await import("../tenant.server");
    await expect(provisionOwnedShop("Acme")).rejects.toMatchObject({ code: "42501" });
    expect(single).toHaveBeenCalledTimes(1);
  });

  it("resolveShopForUser returns the membership shop_id", async () => {
    maybeSingle.mockResolvedValue({ data: { shop_id: "shop1" }, error: null });
    const { resolveShopForUser } = await import("../tenant.server");
    expect(await resolveShopForUser("u1")).toBe("shop1");
  });
});
