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

  it("keeps live variants and gifting choices beside trusted purchase controls", () => {
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
    const stateIds = product.interactions.state.map(({ id }) => id);
    for (const id of ["gilt-engraving", "gilt-wrap", "gilt-recipient", "gilt-recipient-name"]) {
      expect(stateIds.some((candidate) => candidate.endsWith(id))).toBe(true);
    }
    expect(product.html).toContain("Gift note");
    expect(product.html).toContain("Recipient");
    expect(product.html).toContain("Proof shown only when supplied by the merchant");
    const addToCartId = product.trustedSlots.find(({ kind }) => kind === "addToCart")!.id;
    expect(product.html.indexOf("Proof shown only when supplied by the merchant")).toBeLessThan(product.html.indexOf(addToCartId));
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
