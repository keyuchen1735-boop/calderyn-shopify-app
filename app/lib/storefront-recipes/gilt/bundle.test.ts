import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileRecipeConfig } from "../factory";
import { GILT_RECIPE_CONFIG } from "./bundle";
import { GILT_VIDEO_ROLES } from "./assets";

describe("Gilt storefront recipe", () => {
  it("compiles nine route-owned jewelry surfaces", () => {
    const { bundle, report } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(Object.keys(bundle.routes)).toEqual(expect.arrayContaining([
      "home", "collections", "collection", "product", "search", "story", "cart", "checkout", "notFound",
    ]));
    expect(Object.keys(bundle.routes)).toHaveLength(9);
    expect(GILT_RECIPE_CONFIG.archetype).toMatchObject({
      composition: "object-ceremony", hero: "jewelry-ceremony-hero", scroll: "intimate-ceremony", cards: "object-vignettes",
    });
    expect(bundle.designSystem.tokens).toMatchObject({ cream: "#f3ead8", black: "#0b0a08", gold: "#9a6b22" });
  });

  it("keeps live variants and merchant policies beside safe purchase controls", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    const product = bundle.routes.product;
    expect(product.bindings.map(({ ref }) => ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "product.title" }),
      expect.objectContaining({ path: "product.price" }),
      expect.objectContaining({ path: "product.availability" }),
      expect.objectContaining({ path: "variant.title" }),
      expect.objectContaining({ path: "variant.availability" }),
    ]));
    expect(product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(product.interactions.state).toEqual([]);
    expect(GILT_RECIPE_CONFIG.surfaces.product.source.html).not.toContain("data-cd-native-control");
    expect(GILT_RECIPE_CONFIG.surfaces.product.source.html).not.toMatch(/Engraving|Gift note|Recipient name/);
    expect(product.requiredData.map(({ kind }) => kind)).toContain("policyLinks");
    expect(product.html).toContain("Review the merchant's current return and shipping terms");
    expect(product.html).not.toMatch(/Proof shown|social proof/i);
    const addToCartId = product.trustedSlots.find(({ kind }) => kind === "addToCart")!.id;
    expect(product.html.indexOf("Review the merchant's current return and shipping terms")).toBeLessThan(product.html.indexOf(addToCartId));
  });

  it("uses one honest all-products path until live collection data is available", () => {
    const collections = GILT_RECIPE_CONFIG.surfaces.collections.source.html;
    expect(collections).toContain("All products");
    expect(collections).toContain('data-cd-route="collection"');
    expect(collections).not.toMatch(/Nine rooms|Collections of meaning/);
    expect(GILT_RECIPE_CONFIG.surfaces.checkout.source.html).not.toMatch(/engraving|recipient details|in the bag/i);
  });

  it("declares exactly three blocked video roles without invented approvals", () => {
    expect(GILT_VIDEO_ROLES).toEqual(["hero", "hero-alt", "pdp-detail"]);
    expect(GILT_RECIPE_CONFIG.assets.entries).toEqual([]);
    const brief = readFileSync(new URL("./video-brief.md", import.meta.url), "utf8");
    expect(brief.match(/^## \[VIDEO BRIEF — /gm)).toHaveLength(3);
    const proof = JSON.parse(readFileSync(new URL("./video-proof.json", import.meta.url), "utf8")) as { status: string; approved: boolean };
    expect(proof).toEqual(expect.objectContaining({ status: "blocked", approved: false }));
  });
});
