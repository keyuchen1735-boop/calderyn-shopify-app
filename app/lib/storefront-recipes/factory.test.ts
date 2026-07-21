import { describe, expect, it } from "vitest";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import { compileRecipeConfig, defineRecipe, type RecipeConfig, type RecipeMediaArtifacts } from "./factory";

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

function videoHeroConfig(): RecipeConfig<"atelier-nine"> {
  const config = testConfig();
  config.surfaces.home.source.html = `<main><video data-cd-video data-cd-poster-asset="hero-poster" muted autoplay playsinline loop preload="metadata"><source data-cd-asset="hero-webm" type="video/webm"><source data-cd-asset="hero-mp4" type="video/mp4"></video><h1 data-cd-text="store.name"></h1></main>`;
  config.assets.entries = [
    { key: "hero-poster", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 1 },
    { key: "hero-webm", contentHash: "b".repeat(64), mediaType: "video/webm", byteSize: 1 },
    { key: "hero-mp4", contentHash: "c".repeat(64), mediaType: "video/mp4", byteSize: 1 },
  ];
  config.mediaArtifacts = {
    manifest: {
      templateId: "atelier-nine",
      records: [{
        templateId: "atelier-nine",
        role: "hero",
        masterHash: "d".repeat(64),
        duration: 10,
        width: 1600,
        height: 900,
        entries: [
          { contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 1, objectPath: `storefront-recipe-assets/atelier-nine/${"a".repeat(64)}.webp` },
          { contentHash: "b".repeat(64), mediaType: "video/webm", byteSize: 1, objectPath: `storefront-recipe-assets/atelier-nine/${"b".repeat(64)}.webm` },
          { contentHash: "c".repeat(64), mediaType: "video/mp4", byteSize: 1, objectPath: `storefront-recipe-assets/atelier-nine/${"c".repeat(64)}.mp4` },
        ],
      }],
    },
    proof: {
      records: [{
        templateId: "atelier-nine",
        role: "hero",
        masterHash: "d".repeat(64),
        duration: 10,
        width: 1600,
        height: 900,
        technicalApproval: {
          approved: true,
          masterHash: "d".repeat(64),
          derivativeHashes: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
        },
        visualApproval: { approved: true, scope: "full-loop" },
      }],
    },
  };
  return config;
}

function videoArtifacts(config: RecipeConfig<"atelier-nine">): RecipeMediaArtifacts {
  return config.mediaArtifacts!;
}

describe("storefront recipe factory", () => {
  it("rejects non-positive recipe versions", () => {
    const existing = testConfig();
    const invalidConfig = { ...existing, templateId: "larder" as const, templateVersion: 0 };
    // @ts-expect-error New recipe configs require a positive supported version.
    const typedInvalidConfig: RecipeConfig<"larder"> = invalidConfig;

    expect(() => compileRecipeConfig(typedInvalidConfig)).toThrow(/larder.*positive template version/i);
  });

  it("compiles complete route-owned compositions without imposing a shared layout", () => {
    const config = testConfig();
    const result = defineRecipe(config);

    expect(result.report.ok).toBe(true);
    expect(result.bundle.source).toEqual({ kind: "recipe", templateId: "atelier-nine", templateVersion: 1 });
    expect(result.config.archetype.composition).toBe("asymmetric-magazine");
    expect(result.config.surfaces.home.signature).not.toBe(result.config.surfaces.collection.signature);
    expect(result.bundle.routes.home.html).toContain("cd-home-");
    expect(result.bundle.routes.home.trustedSlots.map(({ kind }) => kind)).toContain("quickViewCommerce");
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

  it("accepts a complete poster-first home hero video contract", () => {
    const result = defineRecipe(videoHeroConfig());

    expect(result.report).toMatchObject({ ok: true, diagnostics: [] });
    expect(result.bundle.assets.entries.map(({ key }) => key)).toEqual(
      expect.arrayContaining(["hero-poster", "hero-webm", "hero-mp4"]),
    );
    expect(result.bundle.assets.entries).toHaveLength(3);
  });

  it("rejects incomplete or mistyped poster-first home hero video assets", () => {
    const incomplete = videoHeroConfig();
    incomplete.assets.entries = incomplete.assets.entries.filter(({ key }) => key !== "hero-mp4");
    expect(() => defineRecipe(incomplete)).toThrow(/complete.*home hero|declared home hero/i);

    const mistyped = videoHeroConfig();
    mistyped.assets.entries = mistyped.assets.entries.map((entry) => entry.key === "hero-mp4"
      ? { ...entry, mediaType: "image/webp" }
      : entry);
    expect(() => defineRecipe(mistyped)).toThrow(/complete.*home hero|declared home hero/i);
  });

  it("rejects video heroes without distinct technical and visual approval", () => {
    const missingArtifacts = videoHeroConfig();
    delete missingArtifacts.mediaArtifacts;
    expect(() => defineRecipe(missingArtifacts)).toThrow(/manifest|approval|proof/i);

    const missingProof = videoHeroConfig();
    videoArtifacts(missingProof).proof.records = [];
    expect(() => defineRecipe(missingProof)).toThrow(/approval|proof/i);

    const missingTechnical = videoHeroConfig();
    delete videoArtifacts(missingTechnical).proof.records[0].technicalApproval;
    expect(() => defineRecipe(missingTechnical)).toThrow(/approval|proof/i);

    const missingVisual = videoHeroConfig();
    delete videoArtifacts(missingVisual).proof.records[0].visualApproval;
    expect(() => defineRecipe(missingVisual)).toThrow(/approval|proof/i);
  });

  it("rejects swapped video hero ownership and role identities", () => {
    const swappedManifest = videoHeroConfig();
    videoArtifacts(swappedManifest).manifest.templateId = "larder";
    expect(() => defineRecipe(swappedManifest)).toThrow(/template|ownership|identity/i);

    const swappedTemplate = videoHeroConfig();
    videoArtifacts(swappedTemplate).manifest.records[0].templateId = "larder";
    expect(() => defineRecipe(swappedTemplate)).toThrow(/template|ownership|identity/i);

    const swappedRole = videoHeroConfig();
    videoArtifacts(swappedRole).manifest.records[0].role = "hero-alt";
    expect(() => defineRecipe(swappedRole)).toThrow(/role|hero|identity/i);

    const swappedProofTemplate = videoHeroConfig();
    videoArtifacts(swappedProofTemplate).proof.records[0].templateId = "larder";
    expect(() => defineRecipe(swappedProofTemplate)).toThrow(/approval|proof|identity/i);

    const swappedProofRole = videoHeroConfig();
    videoArtifacts(swappedProofRole).proof.records[0].role = "hero-alt";
    expect(() => defineRecipe(swappedProofRole)).toThrow(/approval|proof|identity/i);
  });

  it("rejects video hero master and derivative hash mismatches", () => {
    const masterMismatch = videoHeroConfig();
    videoArtifacts(masterMismatch).proof.records[0].masterHash = "e".repeat(64);
    expect(() => defineRecipe(masterMismatch)).toThrow(/master|approval|proof/i);

    const technicalMasterMismatch = videoHeroConfig();
    videoArtifacts(technicalMasterMismatch).proof.records[0].technicalApproval!.masterHash = "e".repeat(64);
    expect(() => defineRecipe(technicalMasterMismatch)).toThrow(/master|approval|proof/i);

    const assetMismatch = videoHeroConfig();
    videoArtifacts(assetMismatch).manifest.records[0].entries[0].contentHash = "f".repeat(64);
    expect(() => defineRecipe(assetMismatch)).toThrow(/asset|derivative|hash/i);
  });

  it("rejects incomplete video hero derivative mappings", () => {
    const config = videoHeroConfig();
    const hero = videoArtifacts(config).manifest.records[0];
    hero.entries = hero.entries.slice(0, -1);

    expect(() => defineRecipe(config)).toThrow(/derivative|media|asset/i);
  });

  it("validates referenced video roles on non-home surfaces despite a legacy home image", () => {
    const config = testConfig();
    config.surfaces.product.source.html = `<main><video data-cd-video data-cd-poster-asset="hero-alt-poster"><source data-cd-asset="hero-alt-webm" type="video/webm"><source data-cd-asset="hero-alt-mp4" type="video/mp4"></video></main>`;
    config.assets.entries = [...config.assets.entries,
      { key: "hero-alt-poster", contentHash: "b".repeat(64), mediaType: "image/webp", byteSize: 1 },
      { key: "hero-alt-webm", contentHash: "c".repeat(64), mediaType: "video/webm", byteSize: 1 },
      { key: "hero-alt-mp4", contentHash: "d".repeat(64), mediaType: "video/mp4", byteSize: 1 },
    ];
    expect(() => defineRecipe(config)).toThrow(/hero-alt.*manifest|approval|proof/i);
  });

  it("rejects posterless recipe video on any surface despite a legacy home image", () => {
    const config = testConfig();
    config.surfaces.product.source.html = `<main><video data-cd-video><source data-cd-asset="hero-alt-webm" type="video/webm"><source data-cd-asset="hero-alt-mp4" type="video/mp4"></video></main>`;
    config.assets.entries = [...config.assets.entries,
      { key: "hero-alt-webm", contentHash: "c".repeat(64), mediaType: "video/webm", byteSize: 1 },
      { key: "hero-alt-mp4", contentHash: "d".repeat(64), mediaType: "video/mp4", byteSize: 1 },
    ];
    expect(() => defineRecipe(config)).toThrow(/video.*poster|approval|proof/i);
  });

  it("rejects an approved video role with an extra unapproved source", () => {
    const config = videoHeroConfig();
    config.surfaces.home.source.html = config.surfaces.home.source.html.replace(
      "</video>",
      `<source data-cd-asset="ambient-webm" type="video/webm"></video>`,
    );
    config.assets.entries = [...config.assets.entries, {
      key: "ambient-webm",
      contentHash: "e".repeat(64),
      mediaType: "video/webm",
      byteSize: 1,
    }];
    expect(() => defineRecipe(config)).toThrow(/video.*source|approved media role/i);
  });
});
