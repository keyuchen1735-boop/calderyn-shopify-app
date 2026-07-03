import { describe, it, expect, vi } from "vitest";

const maybeSingle = vi.fn();
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) }),
}));
vi.mock("~/lib/dashboard/session.server", () => ({
  requireVerifiedSession: vi.fn().mockResolvedValue({ shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1", emailVerified: true }),
}));

describe("dashboard splat loader", () => {
  it("uses display_name as the store label for an owned shop", async () => {
    maybeSingle.mockResolvedValue({ data: { display_name: "Acme Goods", shop_domain: null }, error: null });
    const { loader } = await import("../dashboard.$");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(res).toMatchObject({ storeLabel: "Acme Goods", shopDomain: null });
  });

  it("falls back to shop_domain for a Shopify shop", async () => {
    maybeSingle.mockResolvedValue({ data: { display_name: null, shop_domain: "acme.myshopify.com" }, error: null });
    const { loader } = await import("../dashboard.$");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(res).toMatchObject({ storeLabel: "acme.myshopify.com" });
  });
});
