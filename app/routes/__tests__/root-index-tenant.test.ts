import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveTenantShopId = vi.fn();
vi.mock("~/lib/storefront/shop.server", () => ({
  resolveTenantShopId: (...a: unknown[]) => resolveTenantShopId(...a),
}));

beforeEach(() => {
  resolveTenantShopId.mockReset();
});

async function run(url: string): Promise<{ out: unknown; thrown: unknown }> {
  const { loader } = await import("../_index");
  try {
    const out = await loader({ request: new Request(url), params: {}, context: {} } as never);
    return { out, thrown: null };
  } catch (thrown) {
    return { out: undefined, thrown };
  }
}

describe("root index loader (host-aware homepage)", () => {
  it("redirects a tenant host's root to its storefront", async () => {
    resolveTenantShopId.mockResolvedValue("shop-1");
    const { thrown } = await run("https://acme.calderyncompany.com/");
    const res = thrown as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront");
  });

  it("redirects platform hosts' root to the dashboard", async () => {
    resolveTenantShopId.mockResolvedValue(null);
    const { thrown } = await run("https://app.calderyncompany.com/");
    const res = thrown as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
  });

  it("keeps the embedded ?shop= entry redirect ahead of tenant routing", async () => {
    resolveTenantShopId.mockResolvedValue("shop-1");
    const { thrown } = await run("https://app.calderyncompany.com/?shop=acme.myshopify.com&host=h");
    const res = thrown as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/app?shop=acme.myshopify.com");
    // The embedded entry must win before any tenant lookup happens.
    expect(resolveTenantShopId).not.toHaveBeenCalled();
  });

  it("fails open to the dashboard redirect when the tenant lookup errors", async () => {
    resolveTenantShopId.mockImplementation(async () => {
      throw new Error("db down");
    });
    const { thrown } = await run("https://acme.calderyncompany.com/");
    const res = thrown as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
  });
});
