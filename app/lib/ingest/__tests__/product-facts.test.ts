import { describe, expect, it, vi } from "vitest";
import {
  mapShopifyProductFacts,
  syncShopifyProductFacts,
  type ShopifyFactProduct,
} from "../product-facts.server";

function product(id: string, overrides: Partial<ShopifyFactProduct> = {}): ShopifyFactProduct {
  return { id: `gid://shopify/Product/${id}`, title: `Product ${id}`, ...overrides };
}

describe("Shopify product fact ingestion", () => {
  it("maps only the explicit merchant metafield allowlist into closed facts", () => {
    expect(mapShopifyProductFacts(product("1", {
      calderynWidth: { id: "mf-width", type: "dimension", jsonValue: { value: 80, unit: "CENTIMETERS" } },
      calderynMaterials: { id: "mf-material", type: "list.single_line_text_field", jsonValue: ["Walnut", "Steel"] },
      calderynHeatLevel: { id: "mf-heat", type: "number_integer", jsonValue: 4 },
      calderynDocumentUrl: { id: "mf-doc", type: "url", jsonValue: "https://cdn.example/spec.pdf" },
    }))).toMatchObject([
      { externalId: "mf-width", kind: "dimension.width", value: 80, unit: "cm" },
      { externalId: "mf-material#Walnut", kind: "material", value: "Walnut" },
      { externalId: "mf-material#Steel", kind: "material", value: "Steel" },
      { externalId: "mf-heat", kind: "heat_level", value: 4 },
      { externalId: "mf-doc", kind: "document_url", value: "https://cdn.example/spec.pdf" },
    ]);
  });

  it("collects every page before one shop-scoped atomic replacement", async () => {
    const replace = vi.fn<(snapshot: unknown) => Promise<void>>(async () => undefined);
    const fetch = vi.fn(async function* () {
      yield [product("1", { calderynMaterials: { id: "mf-1", type: "list.single_line_text_field", jsonValue: ["Oak"] } })];
      yield [product("2", { calderynHeatLevel: { id: "mf-2", type: "number_integer", jsonValue: 2 } })];
    });

    const result = await syncShopifyProductFacts({ shopId: "shop-a", shopDomain: "a.myshopify.com" }, { fetch, replace });

    expect(fetch).toHaveBeenCalledWith("a.myshopify.com");
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ shopId: "shop-a", provider: "shopify", facts: expect.arrayContaining([
      expect.objectContaining({ productExternalId: "gid://shopify/Product/1", externalId: "mf-1#Oak" }),
      expect.objectContaining({ productExternalId: "gid://shopify/Product/2", externalId: "mf-2" }),
    ]) }));
    expect(result).toEqual({ products: 2, facts: 2 });
  });

  it("is idempotent and lets a complete empty snapshot remove stale provider facts", async () => {
    const replace = vi.fn<(snapshot: unknown) => Promise<void>>(async () => undefined);
    const fetch = async function* () { yield [product("1")]; };
    const input = { shopId: "shop-a", shopDomain: "a.myshopify.com" };
    await syncShopifyProductFacts(input, { fetch, replace });
    await syncShopifyProductFacts(input, { fetch, replace });
    expect(replace.mock.calls[0]).toEqual(replace.mock.calls[1]);
    expect((replace.mock.calls[0][0] as { facts: unknown[] }).facts).toEqual([]);
  });

  it("reports every invalid product and preserves the prior snapshot", async () => {
    const replace = vi.fn<(snapshot: unknown) => Promise<void>>(async () => undefined);
    const fetch = async function* () {
      yield [
        product("1", { calderynWidth: { id: "bad-unit", type: "dimension", jsonValue: { value: 4, unit: "FEET" } } }),
        product("2", { calderynArModelUrl: { id: "bad-url", type: "url", jsonValue: "https://cdn.example/model.exe" } }),
      ];
    };
    await expect(syncShopifyProductFacts({ shopId: "shop-a", shopDomain: "a.myshopify.com" }, { fetch, replace }))
      .rejects.toThrow(/Product 1.*unit.*Product 2.*model/is);
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not replace the prior snapshot when a later page fails", async () => {
    const replace = vi.fn<(snapshot: unknown) => Promise<void>>(async () => undefined);
    const fetch = async function* () {
      yield [product("1")];
      throw new Error("Shopify page 2 failed");
    };
    await expect(syncShopifyProductFacts({ shopId: "shop-a", shopDomain: "a.myshopify.com" }, { fetch, replace }))
      .rejects.toThrow("page 2");
    expect(replace).not.toHaveBeenCalled();
  });
});
