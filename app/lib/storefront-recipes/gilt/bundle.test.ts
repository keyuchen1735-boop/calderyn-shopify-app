import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileRecipeConfig } from "../factory";
import { GILT_RECIPE_CONFIG } from "./bundle";
import { GILT_VIDEO_ROLES } from "./assets";
import type { CompiledNode } from "../../storefront-bundle/types";

function elements(nodes: readonly CompiledNode[]): Array<Extract<CompiledNode, { kind: "element" }>> {
  return nodes.flatMap((node) => node.kind === "text" ? [] : [node, ...elements(node.children)]);
}

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

  it("keeps live variants, trusted gifting fields, and merchant policies beside purchase controls", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    const product = bundle.routes.product;
    expect(product.bindings.map(({ ref }) => ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "product.title" }),
      expect.objectContaining({ path: "product.price" }),
      expect.objectContaining({ path: "product.availability" }),
      expect.objectContaining({ path: "variant.title" }),
      expect.objectContaining({ path: "variant.price" }),
      expect.objectContaining({ path: "variant.availability" }),
    ]));
    expect(product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(product.trustedSlots.find(({ kind }) => kind === "addToCart")).toMatchObject({
      personalizationFields: ["engraving", "giftNote", "giftWrap", "recipient"],
    });
    expect(product.interactions.state).toEqual([]);
    expect(GILT_RECIPE_CONFIG.surfaces.product.source.html).not.toContain("data-cd-native-control");
    expect(product.html).not.toContain("data-cd-personalization");
    expect(product.requiredData.map(({ kind }) => kind)).toContain("policyLinks");
    expect(product.html).toContain("Review the merchant's current return and shipping terms");
    expect(product.html).toContain("Live product • current price • protected personalization");
    const addToCartId = product.trustedSlots.find(({ kind }) => kind === "addToCart")!.id;
    const purchaseColumn = elements(product.tree).find(({ attributes }) => attributes.class === "gilt-purchase")!;
    const purchaseNodes = elements(purchaseColumn.children);
    expect(purchaseNodes.some(({ trustedSlotId }) => trustedSlotId === addToCartId)).toBe(true);
    expect(purchaseNodes.findIndex(({ attributes }) => attributes.class === "gilt-proof")).toBeLessThan(
      purchaseNodes.findIndex(({ trustedSlotId }) => trustedSlotId === addToCartId),
    );
    expect(purchaseNodes.findIndex(({ attributes }) => attributes.class === "gilt-risk")).toBeLessThan(
      purchaseNodes.findIndex(({ trustedSlotId }) => trustedSlotId === addToCartId),
    );
  });

  it("uses one honest all-products path until live collection data is available", () => {
    const collections = GILT_RECIPE_CONFIG.surfaces.collections.source.html;
    expect(collections).toContain("All products");
    expect(collections).toContain('data-cd-route="collection"');
    expect(collections).not.toMatch(/Nine rooms|Collections of meaning/);
    expect(GILT_RECIPE_CONFIG.surfaces.checkout.source.html).not.toMatch(/engraving|recipient details|in the bag/i);
  });

  it("merchandises one or many live products without recipe-owned product claims", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    for (const routeId of ["home", "collection", "search"] as const) {
      const paths = bundle.routes[routeId].bindings.flatMap(({ ref }) => ref.kind === "data" ? [ref.path] : []);
      expect(paths, routeId).toEqual(expect.arrayContaining([
        "product.primaryImage",
        "product.title",
        "product.description",
        "product.price",
        "product.availability",
      ]));
    }
    expect(bundle.routes.home.requiredData.some(({ kind }) => kind === "featuredProducts")).toBe(true);
    expect(bundle.routes.collection.requiredData).toContainEqual({ kind: "currentCollection" });
    expect(bundle.routes.search.requiredData.some(({ kind }) => kind === "searchResults")).toBe(true);
    expect(GILT_RECIPE_CONFIG.surfaces.home.source.html).not.toMatch(/\b(?:necklace|ring|bracelet|earring)\b/i);
  });

  it("keeps gifting and delivery inside protected commerce", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    expect(GILT_RECIPE_CONFIG.surfaces.product.source.html).toContain(
      'data-cd-personalization="engraving giftNote giftWrap recipient"',
    );
    expect(bundle.routes.product.interactions.transitions.map(({ action }) => action.type)).not.toContain("cart.add");
    expect(bundle.shell.trustedSlots.map(({ kind }) => kind)).toContain("cartDrawer");
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );
    expect(bundle.routes.checkout.layout.sectionOrder).toEqual(
      expect.arrayContaining(["contact", "shipping", "delivery", "payment", "summary"]),
    );
    expect(GILT_RECIPE_CONFIG.surfaces.product.source.html).toContain("destination is entered during secure checkout");
  });

  it("keeps the object ceremony legible on wide and narrow storefronts", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    expect(bundle.shell.css).toMatch(/@media\s*\(max-width:760px\)/);
    expect(bundle.shell.css).toMatch(/\.gilt-shell nav a[^}]*min-height:44px/);
    expect(bundle.routes.home.css).toMatch(/position:sticky/);
    expect(bundle.routes.home.css).toMatch(/prefers-reduced-motion:reduce/);
    expect(bundle.routes.product.css).toMatch(/\.gilt-gallery\{[^}]*float:left[^}]*position:sticky/);
    expect(bundle.routes.product.css).toMatch(/\.gilt-purchase-copy\{[^}]*margin-left:55%/);
    expect(bundle.routes.product.css).toMatch(/@media\(max-width:760px\)\{[^}]*\.gilt-gallery[^}]*\}[^}]*\.gilt-purchase-copy\{[^}]*margin-left:0/);
  });

  it("declares exactly three blocked video roles without invented approvals", () => {
    expect(GILT_VIDEO_ROLES).toEqual(["hero", "hero-alt", "pdp-detail"]);
    expect(GILT_RECIPE_CONFIG.assets.entries).toEqual([]);
    const brief = readFileSync(new URL("./video-brief.md", import.meta.url), "utf8");
    expect(brief.match(/^\[VIDEO BRIEF — gilt \/ (?:hero|hero-alt|pdp-detail)\]$/gm)).toEqual([
      "[VIDEO BRIEF — gilt / hero]",
      "[VIDEO BRIEF — gilt / hero-alt]",
      "[VIDEO BRIEF — gilt / pdp-detail]",
    ]);
    for (const field of ["Duration:", "Aspect:", "Style:", "Subject:", "Motion:", "Constraints:"]) {
      expect(brief.match(new RegExp(`^${field}`, "gm")), field).toHaveLength(3);
    }
    const proof = JSON.parse(readFileSync(new URL("./video-proof.json", import.meta.url), "utf8")) as { status: string; approved: boolean };
    expect(proof).toEqual(expect.objectContaining({ status: "blocked", approved: false }));
  });
});
