import { describe, expect, it } from "vitest";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import { defineRecipe, type RecipeConfig } from "./factory";

function testConfig(): RecipeConfig<"atelier-nine"> {
  const source = structuredClone(VALID_BUNDLE_SOURCE);
  source.routes.home.html = `<main><img data-cd-asset="hero" alt="Test hero"><h1 data-cd-text="store.name"></h1></main>`;
  source.assets = {
    entries: [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 1 }],
  };
  return {
    templateId: "atelier-nine",
    templateVersion: 1,
    concept: source.concept,
    designSystem: {
      ...source.designSystem,
      displayFontId: "archivo-narrow",
      bodyFontId: "source-serif-4",
    },
    archetype: {
      composition: "asymmetric-magazine",
      hero: "editorial-grid-hero",
      scroll: "restrained-editorial",
      cards: "magazine-grid",
      iconography: ["thin editorial arrows", "restrained utility marks"],
    },
    surfaces: {
      shell: { signature: "issue masthead utility rail", source: source.shell },
      home: { signature: "offset cover story and product folio", source: source.routes.home },
      collection: { signature: "editorial index with sticky taxonomy", source: source.routes.collection },
      product: { signature: "full bleed lookbook with purchase folio", source: source.routes.product },
      search: { signature: "query desk with ranked story results", source: source.routes.search },
      cart: { signature: "order folio with line-item ledger", source: source.routes.cart },
      checkout: { signature: "quiet trust frame beside platform checkout", source: source.routes.checkout },
    },
    assets: source.assets,
  };
}

describe("storefront recipe factory", () => {
  it("compiles complete route-owned compositions without imposing a shared layout", () => {
    const config = testConfig();
    const result = defineRecipe(config);

    expect(result.report.ok).toBe(true);
    expect(result.bundle.source).toEqual({ kind: "recipe", templateId: "atelier-nine", templateVersion: 1 });
    expect(result.config.archetype.composition).toBe("asymmetric-magazine");
    expect(result.config.surfaces.home.signature).not.toBe(result.config.surfaces.collection.signature);
    expect(result.bundle.routes.home.html).toContain("cd-home-");
    expect(result.bundle.routes.checkout.layout.columnMode).toBe("summaryAside");
  });

  it("rejects configs whose route composition signatures collapse together", () => {
    const config = testConfig();
    for (const surface of Object.values(config.surfaces)) surface.signature = "generic storefront route";

    expect(() => defineRecipe(config)).toThrow(/distinct route composition signatures/i);
  });

  it("rejects recipes without a declared home hero image", () => {
    const config = testConfig();
    config.assets.entries = [];

    expect(() => defineRecipe(config)).toThrow(/declared home hero image/i);
  });
});
