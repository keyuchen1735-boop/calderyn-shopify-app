// Regression guard: the product loader must carry variant shipping fields through
// to the editor view-model. Without the fix, the variants.map reshape dropped
// the 8 shipping fields, causing a blank Shipping section on reopen and a silent
// save-to-zero on the next PUT.

import { describe, it, expect, vi } from "vitest";

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop-uuid-1" }),
}));

const baseVariant = {
  id: "var-1",
  sku: "TSH-S",
  title: "Small",
  retailPriceCents: 2999,
  unitCostCents: null,
  inventoryTracked: null,
  inventoryOnHand: 10,
  optionValueIds: [],
  weightGrams: 340,
  lengthMm: 127,
  widthMm: 90,
  heightMm: 45,
  requiresShipping: true,
  handlingDays: 1,
  signatureRequired: false,
  restrictedCountries: ["RU", "KP"],
};

const baseProduct = {
  id: "prod-1",
  title: "Test Shirt",
  status: "active" as const,
  vendor: null,
  category: null,
  description: null,
  tags: [],
  options: [],
  variants: [baseVariant],
  media: [],
  collectionIds: [],
  updatedAt: "2026-01-01T00:00:00Z",
};

const mockGetProduct = vi.fn().mockResolvedValue(baseProduct);

vi.mock("~/lib/catalog/catalog.server", () => ({
  getProduct: mockGetProduct,
  updateProduct: vi.fn(),
  setProductStatus: vi.fn(),
}));

vi.mock("~/lib/catalog/sign-media.server", () => ({
  signMediaPaths: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("~/lib/catalog/validate", () => ({
  validateProductInput: vi.fn(),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

async function invokeLoader(productId = "prod-1") {
  const { loader } = await import(
    "../../../routes/dashboard.api.catalog.products.$id"
  );
  const request = new Request(
    `https://app.example.com/dashboard/api/catalog/products/${productId}`,
  );
  const response = await loader({
    request,
    params: { id: productId },
    context: {} as never,
  });
  return response.json() as Promise<{
    product: { variants: Array<Record<string, unknown>> };
  }>;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("dashboard.api.catalog.products.$id loader — shipping carry-through", () => {
  it("carries weightGrams and lengthMm from getProduct through to the loader response", async () => {
    mockGetProduct.mockResolvedValueOnce(baseProduct);
    const body = await invokeLoader();
    expect(body.product.variants[0].weightGrams).toBe(340);
    expect(body.product.variants[0].lengthMm).toBe(127);
  });

  it("carries all 8 shipping fields without zeroing or dropping them", async () => {
    mockGetProduct.mockResolvedValueOnce(baseProduct);
    const body = await invokeLoader();
    const v = body.product.variants[0];
    expect(v.weightGrams).toBe(340);
    expect(v.lengthMm).toBe(127);
    expect(v.widthMm).toBe(90);
    expect(v.heightMm).toBe(45);
    expect(v.requiresShipping).toBe(true);
    expect(v.handlingDays).toBe(1);
    expect(v.signatureRequired).toBe(false);
    expect(v.restrictedCountries).toEqual(["RU", "KP"]);
  });

  it("passes requiresShipping: false through (not replaced by ?? undefined)", async () => {
    mockGetProduct.mockResolvedValueOnce({
      ...baseProduct,
      variants: [{ ...baseVariant, requiresShipping: false }],
    });
    const body = await invokeLoader();
    // false ?? undefined === false, so requiresShipping must survive as false
    expect(body.product.variants[0].requiresShipping).toBe(false);
  });

  it("passes empty restrictedCountries array through (not collapsed to undefined)", async () => {
    mockGetProduct.mockResolvedValueOnce({
      ...baseProduct,
      variants: [{ ...baseVariant, restrictedCountries: [] }],
    });
    const body = await invokeLoader();
    // [] ?? undefined === [], so empty array must survive
    expect(body.product.variants[0].restrictedCountries).toEqual([]);
  });
});
