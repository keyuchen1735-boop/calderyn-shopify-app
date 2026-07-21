// D6 preview/live parity: the studio preview renders from
// loadDesignerStoreData while the live serve path shapes catalog products
// itself — the preview used to drop descriptions and compare-at prices, so
// merchants approved cards that changed the moment they went live.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDesignerStoreData } from "./engine.server";

const { getCatalog, getStoreSettings, loadDesignerAssets, applyAssetOverrides, generateMissingListingImages } =
  vi.hoisted(() => ({
    getCatalog: vi.fn(),
    getStoreSettings: vi.fn(),
    loadDesignerAssets: vi.fn(),
    applyAssetOverrides: vi.fn(),
    generateMissingListingImages: vi.fn(),
  }));

vi.mock("../storefront/catalog.server", () => ({ getCatalog }));
vi.mock("../storefront/settings.server", () => ({ getStoreSettings, setComposerEnabled: vi.fn() }));
vi.mock("./imagery.server", () => ({ loadDesignerAssets, generateDesignerAsset: vi.fn(), adoptDesignerAsset: vi.fn() }));
vi.mock("~/lib/storegen/imagery/asset.server", () => ({ applyAssetOverrides, generateMissingListingImages }));

const SHOP = "00000000-0000-0000-0000-000000000010";

const CATALOG_PRODUCT = {
  id: "p1",
  handle: "cedar-smoke",
  title: "Cedar & Smoke",
  description: "A slow-burn soy candle with cedarwood and smoked embers.",
  images: [{ url: "https://cdn.example/cedar.jpg" }],
  variants: [
    { id: "v1", available: true, priceCents: 2400, compareAtPriceCents: 2800 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  getStoreSettings.mockResolvedValue({
    storeName: "Maple & Wick Candle Co.",
    voiceTagline: null,
    logoUrl: null,
  });
  getCatalog.mockReturnValue({ listProducts: vi.fn().mockResolvedValue([CATALOG_PRODUCT]) });
  loadDesignerAssets.mockResolvedValue({});
  applyAssetOverrides.mockImplementation(async (_shop: string, products: unknown[]) => products);
});

describe("loadDesignerStoreData", () => {
  it("carries the catalog description and compare-at price the live page binds", async () => {
    const data = await loadDesignerStoreData(SHOP);
    expect(data.products).toHaveLength(1);
    const product = data.products[0];
    expect(product.description).toBe("A slow-burn soy candle with cedarwood and smoked embers.");
    expect(product.compareAtPriceCents).toBe(2800);
    expect(product.priceCents).toBe(2400);
    expect(product.variantId).toBe("v1");
  });

  it("normalizes an empty description to null, matching the serve path", async () => {
    getCatalog.mockReturnValue({
      listProducts: vi.fn().mockResolvedValue([{ ...CATALOG_PRODUCT, description: "" }]),
    });
    const data = await loadDesignerStoreData(SHOP);
    expect(data.products[0].description).toBeNull();
  });
});
