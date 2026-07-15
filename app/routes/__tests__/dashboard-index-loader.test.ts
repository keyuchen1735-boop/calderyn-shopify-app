import { describe, it, expect, vi } from "vitest";

const maybeSingle = vi.fn();
const limit = vi.fn();
const getProductTourState = vi.fn().mockResolvedValue({ pending: false, available: true });
// Two loader queries ride the same stub: the shops row (…maybeSingle) and the
// product-existence probe (…limit).
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle, limit }) }) }),
  }),
}));
vi.mock("~/lib/dashboard/session.server", () => ({
  requireVerifiedSession: vi.fn().mockResolvedValue({ shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1", emailVerified: true }),
}));
vi.mock("~/lib/dashboard/product-tour.server", () => ({ getProductTourState }));

function stubProducts(rows: Array<{ id: string }> | null, error: unknown = null) {
  limit.mockResolvedValue({ data: rows, error });
}

describe("dashboard splat loader", () => {
  it("uses display_name as the store label for an owned shop", async () => {
    maybeSingle.mockResolvedValue({ data: { display_name: "Acme Goods", shop_domain: null }, error: null });
    stubProducts([{ id: "p1" }]);
    const { loader } = await import("../dashboard.$");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    // canDeleteAccount tracks session.userId — a first-party account here.
    expect(res).toMatchObject({ storeLabel: "Acme Goods", shopDomain: null, canDeleteAccount: true });
  });

  it("passes a new account's pending tour state into the dashboard shell", async () => {
    getProductTourState.mockResolvedValueOnce({ pending: true, available: true });
    maybeSingle.mockResolvedValue({ data: { display_name: "New Shop", shop_domain: null }, error: null });
    stubProducts([]);
    const { loader } = await import("../dashboard.$");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(getProductTourState).toHaveBeenCalledWith("u1");
    expect(res).toMatchObject({ productTourPending: true, productTourAvailable: true });
  });

  it("falls back to shop_domain for a Shopify shop", async () => {
    maybeSingle.mockResolvedValue({ data: { display_name: null, shop_domain: "acme.myshopify.com" }, error: null });
    stubProducts([{ id: "p1" }]);
    const { loader } = await import("../dashboard.$");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(res).toMatchObject({ storeLabel: "acme.myshopify.com", demoMode: false });
  });

  it("flags demo shops so the shell can show the demo-reset card", async () => {
    maybeSingle.mockResolvedValue({
      data: { display_name: "Peak & Pine Outfitters", shop_domain: null, demo_mode: true },
      error: null,
    });
    stubProducts([{ id: "p1" }]);
    const { loader } = await import("../dashboard.$");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(res).toMatchObject({ demoMode: true });
  });

  it("hints hasCatalog=true when the shop has a product (Home paints the established layout)", async () => {
    maybeSingle.mockResolvedValue({ data: { display_name: "Acme Goods", shop_domain: null }, error: null });
    stubProducts([{ id: "p1" }]);
    const { loader } = await import("../dashboard.$");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(res).toMatchObject({ hasCatalog: true });
  });

  it("hints hasCatalog=false for a brand-new shop (Home paints the setup guide)", async () => {
    maybeSingle.mockResolvedValue({ data: { display_name: "New Shop", shop_domain: null }, error: null });
    stubProducts([]);
    const { loader } = await import("../dashboard.$");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(res).toMatchObject({ hasCatalog: false });
  });

  it("defaults hasCatalog=true when the probe errors — never flash the setup guide on a blip", async () => {
    maybeSingle.mockResolvedValue({ data: { display_name: "Acme Goods", shop_domain: null }, error: null });
    stubProducts(null, { message: "timeout" });
    const { loader } = await import("../dashboard.$");
    const res = await loader({ request: new Request("https://app.x/dashboard") } as never);
    expect(res).toMatchObject({ hasCatalog: true });
  });
});
