import { describe, expect, it, vi } from "vitest";
import type { StoreDesignResolution, StorefrontBundleV1 } from "./types";
import { resolveStoreDesign } from "./routing";
import { STORE_TEMPLATE_REGISTRY } from "./registry";
import {
  StorefrontBuildError,
  buildStorefrontDesign,
  prepareStorefrontDesignBuild,
  type StorefrontBuildDependencies,
  type StorefrontBuildEvent,
} from "./build.server";

const SHOP = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const VERSION = "33333333-3333-3333-3333-333333333333";
const PRIOR_DRAFT = "44444444-4444-4444-4444-444444444444";

const evidence = (fingerprint = "sha256:fresh") => ({
  productTitles: ["Refill soap"],
  productTypes: ["refill"],
  productTags: ["low waste"],
  optionNames: [],
  collectionTitles: ["Refill station"],
  fingerprint,
});

const resolution = (fingerprint = "sha256:fresh"): StoreDesignResolution => ({
  kind: "recipe",
  templateId: "commons-index",
  templateVersion: 1,
  selectionKind: "niche_match",
  routingVersion: 1,
  registryVersion: 1,
  catalogFingerprint: fingerprint,
  score: 12,
  runnerUpScore: 0,
  margin: 12,
  confidenceBand: "high",
  breakdown: [],
  reasons: ["Prompt matches a refill shop"],
});

const bundle = {
  schemaVersion: 1,
  runtimeVersion: 1,
  validationProfileVersion: 1,
  source: { kind: "recipe", templateId: "commons-index", templateVersion: 1 },
  assets: { entries: [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 123 }] },
} as unknown as StorefrontBundleV1;

function dependencies(overrides: Partial<StorefrontBuildDependencies> = {}): StorefrontBuildDependencies {
  return {
    buildEvidence: vi.fn().mockResolvedValue(evidence()),
    resolveDesign: vi.fn().mockReturnValue(resolution()),
    loadRecipe: vi.fn().mockResolvedValue({
      bundle,
      report: { profileVersion: 1, ok: true, diagnostics: [] },
    }),
    assertWriteAllowed: vi.fn().mockResolvedValue(undefined),
    readPointers: vi.fn().mockResolvedValue({ draftVersionId: PRIOR_DRAFT, publishedVersionId: null }),
    createVersion: vi.fn().mockResolvedValue(VERSION),
    installDraft: vi.fn().mockResolvedValue(VERSION),
    prepareRecipeImages: vi.fn().mockResolvedValue({ required: 2, ready: 2 }),
    customBuildEnabled: () => true,
    reserveCustomBuild: vi.fn().mockResolvedValue("quota-reservation-1"),
    generateCustom: vi.fn().mockResolvedValue({
      status: "installed",
      versionId: VERSION,
      bundle: { ...bundle, source: { kind: "custom", generationId: "gen-1", promptHash: `sha256:${"b".repeat(64)}` } },
      artifactHash: `sha256:${"c".repeat(64)}`,
      audit: {},
    }),
    ...overrides,
  };
}

describe("runtime-1 storefront build", () => {
  it("freezes the authoritative resolver result as the first event and reuses it for persistence", async () => {
    const deps = dependencies();
    const events: StorefrontBuildEvent[] = [];
    const request = { prompt: "Build a sustainable refill shop", mode: "auto" as const };

    const receipt = await buildStorefrontDesign({
      shopId: SHOP,
      actorId: USER,
      request,
      recipeBuildEnabled: true,
      onEvent: (event) => { events.push(event); },
    }, deps);

    expect(events.map((event) => event.stage)).toEqual([
      "routing",
      "applying_recipe",
      "compiling",
      "validating",
      "proofing",
      "installed",
    ]);
    expect(events[0]).toEqual({
      stage: "routing",
      resolution: resolution(),
      recommendationChanged: false,
    });
    expect(receipt).toEqual({ runtime: 1, versionId: VERSION, status: "draft", resolution: resolution() });
    expect(deps.resolveDesign).toHaveBeenCalledWith(request, evidence());
    expect(deps.loadRecipe).toHaveBeenCalledWith("commons-index", 1);
    expect(deps.prepareRecipeImages).toHaveBeenCalledWith(SHOP, expect.any(AbortSignal));
    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      shopId: SHOP,
      sourceKind: "recipe",
      templateId: "commons-index",
      templateVersion: 1,
      status: "validated",
      artifact: { sourceKind: "recipe", bundle },
      assetManifest: bundle.assets,
      generationPrompt: request.prompt,
      resolution: expect.objectContaining({
        ...resolution(),
        request,
        evidence: evidence(),
      }),
    }));
    expect(deps.installDraft).toHaveBeenCalledWith({
      shopId: SHOP,
      versionId: VERSION,
      expectedDraftVersionId: PRIOR_DRAFT,
      actorId: USER,
    });
  });

  it("preserves an explicit recipe selection regardless of catalog evidence", async () => {
    const manual = { ...resolution(), templateId: "atelier-nine" as const, selectionKind: "manual_override" as const };
    const atelierBundle = {
      ...bundle,
      source: { kind: "recipe" as const, templateId: "atelier-nine" as const, templateVersion: 1 },
    };
    const deps = dependencies({
      readPointers: vi.fn().mockResolvedValue({ draftVersionId: null, publishedVersionId: null }),
      resolveDesign: vi.fn().mockReturnValue(manual),
      loadRecipe: vi.fn().mockResolvedValue({
        bundle: atelierBundle,
        report: { profileVersion: 1, ok: true, diagnostics: [] },
      }),
    });
    const request = { prompt: "Try a skincare look", mode: "recipe" as const, templateId: "atelier-nine" as const };

    await buildStorefrontDesign({ shopId: SHOP, actorId: USER, request, recipeBuildEnabled: true }, deps);

    expect(deps.resolveDesign).toHaveBeenCalledWith(request, evidence());
    expect(deps.loadRecipe).toHaveBeenCalledWith("atelier-nine", 1);
  });

  it("forces a first custom request through recipe matching until a draft exists", async () => {
    const deps = dependencies({
      readPointers: vi.fn().mockResolvedValue({ draftVersionId: null, publishedVersionId: null }),
    });

    await buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "Create something completely new", mode: "custom" },
      recipeBuildEnabled: true,
    }, deps);

    expect(deps.resolveDesign).toHaveBeenCalledWith(
      { prompt: "Create something completely new", mode: "auto" },
      evidence(),
    );
    expect(deps.generateCustom).not.toHaveBeenCalled();
  });

  it("keeps explicit from-scratch language on the first build out of the custom compiler", async () => {
    const deps = dependencies({
      readPointers: vi.fn().mockResolvedValue({ draftVersionId: null, publishedVersionId: null }),
      resolveDesign: (request, currentEvidence) => resolveStoreDesign(request, currentEvidence, STORE_TEMPLATE_REGISTRY),
    });

    const receipt = await buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "Create a completely new store from scratch", mode: "custom" },
      recipeBuildEnabled: true,
    }, deps);

    expect(receipt.resolution.kind).toBe("recipe");
    expect(deps.generateCustom).not.toHaveBeenCalled();
  });

  it("explains when fresh catalog evidence changes the earlier recommendation", async () => {
    const deps = dependencies();
    const events: StorefrontBuildEvent[] = [];
    await buildStorefrontDesign({
      shopId: SHOP,
      actorId: USER,
      request: { prompt: "Build a sustainable refill shop", mode: "auto" },
      recommendedResolution: resolution("sha256:stale"),
      recipeBuildEnabled: true,
      onEvent: (event) => { events.push(event); },
    }, deps);

    expect(events[0]).toEqual(expect.objectContaining({
      stage: "routing",
      resolution: resolution(),
      recommendationChanged: true,
      recommendationChangeReason: "Your catalog changed, so this build uses the latest store recommendation.",
    }));
  });

  it("refuses an experiment or failed validation before creating or installing a release", async () => {
    const experiment = dependencies({
      assertWriteAllowed: vi.fn().mockRejectedValue(new StorefrontBuildError("experiment_running", "Stop the test first.", 409)),
    });
    await expect(buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "refills", mode: "auto" },
      recipeBuildEnabled: true,
    }, experiment)).rejects.toMatchObject({ code: "experiment_running", status: 409 });
    expect(experiment.createVersion).not.toHaveBeenCalled();
    expect(experiment.installDraft).not.toHaveBeenCalled();

    const invalid = dependencies({
      loadRecipe: vi.fn().mockResolvedValue({
        bundle,
        report: { profileVersion: 1, ok: false, diagnostics: [{ code: "x", path: "home", message: "bad" }] },
      }),
    });
    await expect(buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "refills", mode: "auto" },
      recipeBuildEnabled: true,
    }, invalid)).rejects.toMatchObject({ code: "storefront_recipe_invalid", status: 500 });
    expect(invalid.createVersion).not.toHaveBeenCalled();
    expect(invalid.installDraft).not.toHaveBeenCalled();
  });

  it("does not install an image-less first recipe when required generation fails", async () => {
    const deps = dependencies({ prepareRecipeImages: vi.fn().mockResolvedValue({ required: 2, ready: 0 }) });
    await expect(buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "refills", mode: "auto" },
      recipeBuildEnabled: true,
    }, deps)).rejects.toMatchObject({ code: "storefront_recipe_imagery_failed", status: 502 });
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.installDraft).not.toHaveBeenCalled();
  });

  it("preflights build switches and write conflicts before any streamed build work", async () => {
    const deps = dependencies();

    await expect(prepareStorefrontDesignBuild({
      shopId: SHOP,
      request: { prompt: "refills", mode: "auto" },
      recipeBuildEnabled: false,
    }, deps)).rejects.toMatchObject({ code: "storefront_recipe_build_disabled", status: 503 });
    expect(deps.loadRecipe).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();

    const customDeps = dependencies({ resolveDesign: vi.fn().mockReturnValue({
      kind: "custom",
      reason: "explicit_custom",
      routingVersion: 1,
      registryVersion: 1,
      catalogFingerprint: "sha256:fresh",
      breakdown: [],
      reasons: ["Original design requested"],
    }) });
    await expect(prepareStorefrontDesignBuild({
      shopId: SHOP,
      request: { prompt: "Create something completely new", mode: "custom" },
      customBuildEnabled: false,
    }, customDeps)).rejects.toMatchObject({ code: "storefront_custom_build_disabled", status: 503 });

    const conflict = dependencies({
      assertWriteAllowed: vi.fn().mockRejectedValue(new StorefrontBuildError("experiment_running", "Stop the test first.", 409)),
    });
    await expect(prepareStorefrontDesignBuild({
      shopId: SHOP,
      request: { prompt: "refills", mode: "auto" },
      recipeBuildEnabled: true,
    }, conflict)).rejects.toMatchObject({ code: "experiment_running", status: 409 });
    expect(conflict.readPointers).not.toHaveBeenCalled();
  });

  it("routes a custom resolution into the original compiler and installs its receipt", async () => {
    const customResolution: StoreDesignResolution = {
      kind: "custom",
      reason: "explicit_custom",
      routingVersion: 1,
      registryVersion: 1,
      catalogFingerprint: "sha256:fresh",
      breakdown: [],
      reasons: ["Original design requested"],
    };
    const customDeps = dependencies({ resolveDesign: vi.fn().mockReturnValue(customResolution) });
    const events: StorefrontBuildEvent[] = [];
    const receipt = await buildStorefrontDesign({
      shopId: SHOP,
      actorId: USER,
      trusted: true,
      request: { prompt: "Create something completely new", mode: "custom" },
      customBuildEnabled: true,
      onEvent: (event) => { events.push(event); },
    }, customDeps);

    expect(customDeps.generateCustom).toHaveBeenCalledWith(expect.objectContaining({
      shopId: SHOP,
      actorId: USER,
      trusted: true,
      prompt: "Create something completely new",
      expectedDraftVersionId: PRIOR_DRAFT,
      routingResolution: customResolution,
      quotaReservationToken: "quota-reservation-1",
    }));
    expect(customDeps.reserveCustomBuild).toHaveBeenCalledTimes(1);
    expect(customDeps.loadRecipe).not.toHaveBeenCalled();
    expect(customDeps.createVersion).not.toHaveBeenCalled();
    expect(events.map((event) => event.stage)).toEqual(["routing", "generating_original", "installed"]);
    expect(receipt).toEqual({ runtime: 1, versionId: VERSION, status: "draft", resolution: customResolution });
  });

  it("leaves the current draft untouched when release creation fails", async () => {
    const deps = dependencies({ createVersion: vi.fn().mockRejectedValue(new Error("database unavailable")) });
    await expect(buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "refills", mode: "auto" },
      recipeBuildEnabled: true,
    }, deps)).rejects.toThrow("database unavailable");
    expect(deps.installDraft).not.toHaveBeenCalled();
  });
});
