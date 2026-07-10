// Search-listing plumbing: applySeoOverrideInput must delete the seo_page row
// when both fields are empty (draft wins again) and upsert otherwise;
// seoListingFor must layer the stored override next to the deterministic
// defaults, prefer the tenant origin for the URL prefix, and degrade the
// placeholders (never 500) when the settings read fails.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProductDetail } from "../types";

const getSeoOverride = vi.hoisted(() => vi.fn());
const upsertSeoOverride = vi.hoisted(() => vi.fn());
const deleteSeoOverride = vi.hoisted(() => vi.fn());
vi.mock("~/lib/seo/seo-store.server", () => ({
  getSeoOverride: (...a: unknown[]) => getSeoOverride(...a),
  upsertSeoOverride: (...a: unknown[]) => upsertSeoOverride(...a),
  deleteSeoOverride: (...a: unknown[]) => deleteSeoOverride(...a),
}));

const getStoreSettings = vi.hoisted(() => vi.fn());
vi.mock("~/lib/storefront/settings.server", () => ({
  getStoreSettings: (...a: unknown[]) => getStoreSettings(...a),
}));

const tenantStorefrontOrigin = vi.hoisted(() => vi.fn());
vi.mock("~/lib/storefront/tenant-origin.server", () => ({
  tenantStorefrontOrigin: (...a: unknown[]) => tenantStorefrontOrigin(...a),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { seoListingFor, applySeoOverrideInput } from "../product-seo.server";

const SHOP = "shop-1";
const PRODUCT: ProductDetail = {
  id: "p1",
  handle: "cozy-tee-a1b2c3",
  title: "Cozy Tee",
  status: "active",
  vendor: null,
  category: null,
  description: "<p>Soft cotton tee.</p>",
  tags: [],
  options: [],
  variants: [],
  media: [],
  collectionIds: [],
  updatedAt: "2026-07-10T00:00:00Z",
};
const SETTINGS = { storeName: "Acme Goods" };
const req = () => new Request("https://app.calderyncompany.com/dashboard/api/catalog/products/p1");

beforeEach(() => {
  vi.clearAllMocks();
  getSeoOverride.mockResolvedValue(null);
  getStoreSettings.mockResolvedValue(SETTINGS);
  tenantStorefrontOrigin.mockResolvedValue("https://acme.calderyncompany.com");
  upsertSeoOverride.mockResolvedValue(undefined);
  deleteSeoOverride.mockResolvedValue(undefined);
});

describe("applySeoOverrideInput", () => {
  it("deletes the override when both fields are empty", async () => {
    await applySeoOverrideInput(SHOP, "p1", { metaTitle: "", metaDescription: "" });
    expect(deleteSeoOverride).toHaveBeenCalledWith(SHOP, "product", "p1");
    expect(upsertSeoOverride).not.toHaveBeenCalled();
  });

  it("upserts when both fields carry values", async () => {
    await applySeoOverrideInput(SHOP, "p1", { metaTitle: "T", metaDescription: "D" });
    expect(upsertSeoOverride).toHaveBeenCalledWith(SHOP, {
      entityType: "product", entityId: "p1", metaTitle: "T", metaDescription: "D",
    });
    expect(deleteSeoOverride).not.toHaveBeenCalled();
  });

  it("stores an empty field as null so the draft supplies that half", async () => {
    await applySeoOverrideInput(SHOP, "p1", { metaTitle: "T", metaDescription: "" });
    expect(upsertSeoOverride).toHaveBeenCalledWith(SHOP, {
      entityType: "product", entityId: "p1", metaTitle: "T", metaDescription: null,
    });
  });
});

describe("seoListingFor", () => {
  it("returns deterministic defaults with the tenant-origin URL prefix and no override", async () => {
    const out = await seoListingFor(req(), SHOP, PRODUCT);
    expect(out.metaTitle).toBeNull();
    expect(out.metaDescription).toBeNull();
    expect(out.defaultTitle).toBe("Cozy Tee · Acme Goods");
    expect(out.defaultDescription).toBe("Soft cotton tee.");
    expect(out.urlPrefix).toBe("https://acme.calderyncompany.com/storefront/products/");
  });

  it("surfaces a stored override alongside the defaults", async () => {
    getSeoOverride.mockResolvedValue({
      entityType: "product", entityId: "p1", metaTitle: "Hand-set title", metaDescription: null,
    });
    const out = await seoListingFor(req(), SHOP, PRODUCT);
    expect(out.metaTitle).toBe("Hand-set title");
    expect(out.metaDescription).toBeNull();
    expect(out.defaultTitle).toBe("Cozy Tee · Acme Goods");
  });

  it("falls back to the request origin when the shop has no tenant slug", async () => {
    tenantStorefrontOrigin.mockResolvedValue(null);
    const out = await seoListingFor(req(), SHOP, PRODUCT);
    expect(out.urlPrefix).toBe("https://app.calderyncompany.com/storefront/products/");
  });

  it("degrades placeholders (never throws) when the settings read fails", async () => {
    getStoreSettings.mockRejectedValue(new Error("settings down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await seoListingFor(req(), SHOP, PRODUCT);
    expect(out.defaultTitle).toBe("Cozy Tee");
    expect(out.defaultDescription).toBe("Soft cotton tee.");
    expect(out.urlPrefix).toBe("https://app.calderyncompany.com/storefront/products/");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("propagates an override-read failure (load-bearing for the save round-trip)", async () => {
    getSeoOverride.mockRejectedValue(new Error("seo_page read failed"));
    await expect(seoListingFor(req(), SHOP, PRODUCT)).rejects.toThrow("seo_page read failed");
  });
});
