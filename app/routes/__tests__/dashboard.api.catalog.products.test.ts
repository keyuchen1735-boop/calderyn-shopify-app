import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue({
    shopId: "shop1",
    shopDomain: null,
    userId: "u1",
    sessionId: "s1",
  }),
}));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  dashboardJson: async (fn: () => Promise<unknown>) =>
    new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string) =>
    new Response(JSON.stringify({ error: e }), { status: s }),
}));
const listProducts = vi.fn().mockResolvedValue({ products: [], total: 0 });
const createProduct = vi.fn().mockResolvedValue({ id: "p1" });
const getProduct = vi.fn();
const updateProduct = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/catalog/catalog.server", () => ({
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  setProductStatus: vi.fn(),
}));
const validateProductInput = vi.fn((body: unknown) => ({
  ok: true,
  value: body,
}));
vi.mock("~/lib/catalog/validate", () => ({ validateProductInput }));
const signMediaPaths = vi
  .fn()
  .mockResolvedValue(new Map([["shop1/p1/x.png", "https://signed/x"]]));
vi.mock("~/lib/catalog/sign-media.server", () => ({
  signMediaPaths,
  signMediaPath: vi.fn(),
}));

beforeEach(() => {
  listProducts.mockClear();
  createProduct.mockClear();
  getProduct.mockReset();
  updateProduct.mockClear();
  validateProductInput.mockClear();
  signMediaPaths.mockClear();
});

describe("catalog products route", () => {
  it("GET lists products for the session shop", async () => {
    const { loader } = await import("../dashboard.api.catalog.products._index");
    const res = (await loader({
      request: new Request("https://app.x/dashboard/api/catalog/products"),
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(listProducts).toHaveBeenCalledWith("shop1", expect.any(Object));
  });

  it("POST creates a product", async () => {
    const { action } = await import("../dashboard.api.catalog.products._index");
    const req = new Request("https://app.x/dashboard/api/catalog/products", {
      method: "POST",
      body: JSON.stringify({
        title: "Tee",
        status: "active",
        variants: [{ sku: "S" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = (await action({ request: req } as never)) as Response;
    expect(res.status).toBe(200);
    expect(createProduct).toHaveBeenCalledWith(
      "shop1",
      expect.objectContaining({ title: "Tee" }),
    );
  });

  it("GET :id reshapes the stored detail into the editor view-model", async () => {
    getProduct.mockResolvedValue({
      id: "p1",
      title: "Tee",
      status: "active",
      vendor: "Acme",
      category: "Shirts",
      description: null,
      tags: ["new"],
      options: [
        {
          id: "o1",
          name: "Size",
          values: [
            { id: "ov1", value: "S" },
            { id: "ov2", value: "M" },
          ],
        },
      ],
      variants: [
        {
          id: "var-m",
          sku: "TEE-M",
          title: "M",
          retailPriceCents: 1999,
          unitCostCents: null,
          inventoryTracked: null,
          inventoryOnHand: 4,
          optionValueIds: ["ov2"],
        },
      ],
      media: [
        {
          id: "m1",
          storagePath: "shop1/p1/x.png",
          alt: null,
          position: 0,
          isPrimary: true,
        },
      ],
      collectionIds: ["c1"],
      updatedAt: "t",
    });
    const { loader } = await import("../dashboard.api.catalog.products.$id");
    const res = (await loader({
      request: new Request("https://app.x/dashboard/api/catalog/products/p1"),
      params: { id: "p1" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    const { product } = (await res.json()) as {
      product: {
        options: Array<{ name: string; values: string[] }>;
        variants: Array<{ optionValues: string[]; sku?: string }>;
        media: Array<{ url: string }>;
        category?: string;
        description?: string;
      };
    };
    // options collapse to string[]; the variant's value id resolves to its label
    expect(product.options).toEqual([{ name: "Size", values: ["S", "M"] }]);
    expect(product.variants[0].optionValues).toEqual(["M"]);
    expect(product.variants[0].sku).toBe("TEE-M");
    // media path is signed; null description becomes undefined; category round-trips
    expect(product.media[0].url).toBe("https://signed/x");
    expect(product.category).toBe("Shirts");
    expect(product.description).toBeUndefined();
  });

  it("GET :id 404s when the product is not the shop's", async () => {
    getProduct.mockResolvedValue(null);
    const { loader } = await import("../dashboard.api.catalog.products.$id");
    // The loader throws a 404 Response (Remix not-found pattern); the real
    // dashboardJson rethrows anything `instanceof Response`.
    await expect(
      loader({
        request: new Request(
          "https://app.x/dashboard/api/catalog/products/nope",
        ),
        params: { id: "nope" },
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("PUT validates against the stored product before updating", async () => {
    const previous = { id: "p1", status: "active", variants: [{ id: "v1" }] };
    getProduct.mockResolvedValue(previous);
    const body = {
      title: "Tee",
      status: "active",
      variants: [{ id: "v1", requiresShipping: true, weightGrams: 340 }],
      seo: { metaTitle: "Tee", metaDescription: "" },
    };
    const { action } = await import("../dashboard.api.catalog.products.$id");
    const request = new Request(
      "https://app.x/dashboard/api/catalog/products/p1",
      {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );
    const response = (await action({
      request,
      params: { id: "p1" },
    } as never)) as Response;

    expect(response.status).toBe(200);
    expect(validateProductInput).toHaveBeenCalledWith(body, { previous });
    expect(updateProduct).toHaveBeenCalledWith("shop1", "p1", body);
  });
});
