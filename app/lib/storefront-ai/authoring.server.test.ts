import { describe, expect, it } from "vitest";
import { CUSTOM_BENCH_BUNDLE, CUSTOM_BENCH_RECIPE } from "~/lib/storefront-recipes/custom-bench/bundle";
import {
  authoringFromRecipe,
  compileAuthoring,
  parseStorefrontVersionArtifact,
  requireStorefrontAuthoring,
} from "./authoring.server";

const VERSION_ID = "00000000-0000-4000-8000-000000000001";

describe("storefront authoring artifacts", () => {
  it("seeds custom source from the exact bound recipe and preserves ancestry", () => {
    const artifact = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
      generationId: "gen-1",
      promptHash: "sha256:prompt",
      derivedFromVersionId: VERSION_ID,
    });

    expect(artifact.authoring.source.source).toMatchObject({
      kind: "custom",
      generationId: "gen-1",
      promptHash: "sha256:prompt",
      derivedFromVersionId: VERSION_ID,
      derivedFromTemplateId: "custom-bench",
      derivedFromTemplateVersion: CUSTOM_BENCH_RECIPE.config.templateVersion,
    });
    expect(artifact.authoring.source.shell).toEqual(CUSTOM_BENCH_RECIPE.config.surfaces.shell.source);
    expect(artifact.authoring.source.routes.checkout).toEqual(CUSTOM_BENCH_RECIPE.config.surfaces.checkout.source);
    expect(compileAuthoring(artifact.authoring).bundle.source.kind).toBe("custom");
  });

  it("rejects structural source access for legacy custom artifacts", () => {
    const seeded = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
      generationId: "legacy-gen",
      promptHash: "sha256:legacy",
      derivedFromVersionId: VERSION_ID,
    });
    const artifact = parseStorefrontVersionArtifact({
      sourceKind: "custom",
      bundle: seeded.bundle,
    });

    expect(() => requireStorefrontAuthoring(artifact)).toThrow(/authoring source/i);
  });

  it("round-trips valid custom authoring and its runtime overrides", () => {
    const recipe = structuredClone(CUSTOM_BENCH_RECIPE);
    recipe.bundle.featuredProductIds = ["product-1"];
    recipe.bundle.visualLayer = { kind: "none" };
    const seeded = authoringFromRecipe(recipe, {
      generationId: "gen-2",
      promptHash: "sha256:second",
      derivedFromVersionId: VERSION_ID,
    });

    const parsed = parseStorefrontVersionArtifact(JSON.parse(JSON.stringify(seeded)));
    const compiled = compileAuthoring(requireStorefrontAuthoring(parsed));

    expect(compiled.report.ok).toBe(true);
    expect(compiled.bundle.featuredProductIds).toEqual(["product-1"]);
    expect(compiled.bundle.visualLayer).toEqual({ kind: "none" });
  });

  it("keeps malformed authoring from blocking legacy rendering but denies source access", () => {
    const seeded = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
      generationId: "malformed-gen",
      promptHash: "sha256:malformed",
      derivedFromVersionId: VERSION_ID,
    });
    const artifact = parseStorefrontVersionArtifact({
      sourceKind: "custom",
      bundle: seeded.bundle,
      authoring: { version: 1, source: null, overrides: {} },
    });

    expect(artifact.bundle).toBe(seeded.bundle);
    expect(() => requireStorefrontAuthoring(artifact)).toThrow(/authoring source/i);
  });

  it("denies authoring when artifact and compiled source kinds disagree", () => {
    const seeded = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
      generationId: "gen-3",
      promptHash: "sha256:third",
      derivedFromVersionId: VERSION_ID,
    });

    expect(() => parseStorefrontVersionArtifact({ ...seeded, sourceKind: "recipe" }))
      .toThrow(/source kind/i);
    expect(() => parseStorefrontVersionArtifact({ sourceKind: "custom", bundle: CUSTOM_BENCH_BUNDLE }))
      .toThrow(/source kind/i);
  });

  it.each(["generationId", "promptHash", "derivedFromVersionId"])(
    "denies authoring missing required custom provenance %s",
    (field) => {
      const seeded = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
        generationId: "gen-4",
        promptHash: "sha256:fourth",
        derivedFromVersionId: VERSION_ID,
      });
      delete (seeded.authoring.source.source as unknown as Record<string, unknown>)[field];
      seeded.bundle = compileAuthoring(seeded.authoring).bundle;

      const parsed = parseStorefrontVersionArtifact(seeded);

      expect(parsed.bundle).toEqual(seeded.bundle);
      expect(() => requireStorefrontAuthoring(parsed)).toThrow(/authoring source/i);
    },
  );

  it.each(["derivedFromTemplateId", "derivedFromTemplateVersion"])(
    "denies authoring with incomplete recipe ancestry missing %s",
    (field) => {
      const seeded = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
        generationId: "gen-5",
        promptHash: "sha256:fifth",
        derivedFromVersionId: VERSION_ID,
      });
      delete (seeded.authoring.source.source as unknown as Record<string, unknown>)[field];
      seeded.bundle = compileAuthoring(seeded.authoring).bundle;

      const parsed = parseStorefrontVersionArtifact(seeded);

      expect(() => requireStorefrontAuthoring(parsed)).toThrow(/authoring source/i);
    },
  );

  it.each([
    ["unknown override", { extra: true }],
    ["numeric product ID", { featuredProductIds: [123] }],
    ["invalid visual layer", { visualLayer: { kind: "none", extra: true } }],
  ])("denies authoring with %s", (_label, invalidOverride) => {
    const seeded = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
      generationId: "gen-6",
      promptHash: "sha256:sixth",
      derivedFromVersionId: VERSION_ID,
    });
    Object.assign(seeded.authoring.overrides, invalidOverride);

    expect(() => compileAuthoring(seeded.authoring)).toThrow(/overrides/i);
    const parsed = parseStorefrontVersionArtifact(seeded);

    expect(() => requireStorefrontAuthoring(parsed)).toThrow(/authoring source/i);
  });
});
