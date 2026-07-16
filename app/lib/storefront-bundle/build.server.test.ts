import { describe, expect, it, vi } from "vitest";
import {
  buildStorefrontDesign,
  prepareStorefrontDesignBuild,
  type StorefrontBuildError,
  type StorefrontBuildDependencies,
  type StorefrontBuildEvent,
} from "./build.server";
import type { StoreDesignResolution, StorefrontBundleV1 } from "./types";

const SHOP = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const VERSION = "33333333-3333-3333-3333-333333333333";
const PRIOR = "44444444-4444-4444-4444-444444444444";

const evidence = {
  productTitles: ["Refill soap"], productTypes: ["refill"], productTags: ["low waste"],
  optionNames: [], collectionTitles: ["Refill station"], fingerprint: "sha256:catalog",
};

const resolution: Extract<StoreDesignResolution, { kind: "recipe" }> = {
  kind: "recipe",
  templateId: "commons-index",
  templateVersion: 1,
  selectionKind: "niche_match",
  routingVersion: 1,
  registryVersion: 1,
  catalogFingerprint: evidence.fingerprint,
  score: 12,
  runnerUpScore: 0,
  margin: 12,
  confidenceBand: "high",
  breakdown: [],
  reasons: ["match"],
};

const bundle = {
  schemaVersion: 1,
  runtimeVersion: 1,
  validationProfileVersion: 1,
  source: { kind: "recipe", templateId: "commons-index", templateVersion: 1 },
  assets: { entries: [] },
} as unknown as StorefrontBundleV1;

function dependencies(overrides: Partial<StorefrontBuildDependencies> = {}): StorefrontBuildDependencies {
  return {
    buildEvidence: vi.fn().mockResolvedValue(evidence),
    resolveDesign: vi.fn().mockReturnValue(resolution),
    loadRecipe: vi.fn().mockResolvedValue({
      bundle,
      report: { profileVersion: 1, ok: true, diagnostics: [] },
    }),
    assertWriteAllowed: vi.fn().mockResolvedValue(undefined),
    readPointers: vi.fn().mockResolvedValue({ draftVersionId: PRIOR, publishedVersionId: null }),
    validate: vi.fn().mockReturnValue({ profileVersion: 1, ok: true, diagnostics: [] }),
    loadProofContext: vi.fn().mockResolvedValue({ products: [], collections: [] }),
    prove: vi.fn().mockResolvedValue({ ok: true, diagnostics: [], screenshots: ["proof"], browserMs: 1 }),
    createVersion: vi.fn().mockResolvedValue(VERSION),
    installDraft: vi.fn().mockResolvedValue(VERSION),
    ...overrides,
  };
}

describe("recipe-only storefront build bridge", () => {
  it("browser-proves before version creation and CAS installation", async () => {
    const deps = dependencies();
    const events: StorefrontBuildEvent[] = [];
    const request = { prompt: "Build a refill shop", mode: "auto" as const };

    const receipt = await buildStorefrontDesign({
      shopId: SHOP,
      actorId: USER,
      request,
      recipeBuildEnabled: true,
      onEvent: (event) => { events.push(event); },
    }, deps);

    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.installDraft).mock.invocationCallOrder[0]!);
    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      artifact: { sourceKind: "recipe", bundle },
      validationReport: expect.objectContaining({
        valid: true,
        browserProof: expect.objectContaining({ ok: true }),
      }),
    }));
    expect(deps.installDraft).toHaveBeenCalledWith({
      shopId: SHOP,
      versionId: VERSION,
      expectedDraftVersionId: PRIOR,
      actorId: USER,
    });
    expect(receipt).toEqual({ runtime: 1, versionId: VERSION, status: "draft" });
    expect(events.map(({ stage }) => stage)).toEqual([
      "routing", "applying_recipe", "compiling", "validating", "proofing", "installed",
    ]);
    expect(JSON.stringify(events)).not.toContain("commons-index");
  });

  it("keeps image generation outside the first-preview path", async () => {
    const providerGeneration = vi.fn().mockRejectedValue(new Error("provider down"));
    const deps = Object.assign(dependencies(), { prepareRecipeImages: providerGeneration });

    await expect(buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "refills", mode: "auto" },
      recipeBuildEnabled: true,
    }, deps)).resolves.toEqual({ runtime: 1, versionId: VERSION, status: "draft" });
    expect(providerGeneration).not.toHaveBeenCalled();
  });

  it("browser-proves a catalog-led build with an empty legacy prompt", async () => {
    const deps = dependencies();

    await buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "", mode: "auto" },
      recipeBuildEnabled: true,
    }, deps);

    expect(deps.loadProofContext).toHaveBeenCalledWith({ shopId: SHOP, prompt: "Build my store" });
    expect(deps.prove).toHaveBeenCalledOnce();
  });

  it("has no custom generator or quota dependency and maps legacy custom requests to recipes", async () => {
    const deps = dependencies();

    await buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "Create something from scratch", mode: "custom" },
      recipeBuildEnabled: true,
    }, deps);

    expect(deps.loadRecipe).toHaveBeenCalledWith("commons-index", 1);
    expect(Object.keys(deps)).not.toEqual(expect.arrayContaining(["generateCustom", "reserveCustomBuild"]));
  });

  it("rejects disabled or exhausted recipe selection before loading or writing", async () => {
    const disabled = dependencies();
    await expect(prepareStorefrontDesignBuild({
      shopId: SHOP,
      request: { prompt: "refills", mode: "auto" },
      recipeBuildEnabled: false,
    }, disabled)).rejects.toMatchObject({ code: "storefront_recipe_build_disabled", status: 503 });

    const exhausted = dependencies({ resolveDesign: vi.fn().mockReturnValue({
      kind: "no_match", reason: "all_designs_excluded", routingVersion: 1, registryVersion: 1,
      catalogFingerprint: evidence.fingerprint, breakdown: [], reasons: ["none"],
    }) });
    await expect(prepareStorefrontDesignBuild({
      shopId: SHOP,
      request: { prompt: "another", mode: "auto" },
      recipeBuildEnabled: true,
    }, exhausted)).rejects.toMatchObject({ code: "storefront_design_exhausted", status: 409 });

    for (const deps of [disabled, exhausted]) {
      expect(deps.loadRecipe).not.toHaveBeenCalled();
      expect(deps.createVersion).not.toHaveBeenCalled();
      expect(deps.installDraft).not.toHaveBeenCalled();
    }
  });

  it("does not create or install on static or browser proof failure", async () => {
    const invalid = dependencies({
      validate: vi.fn().mockReturnValue({
        profileVersion: 1, ok: false, diagnostics: [{ code: "bad", path: "home", message: "bad" }],
      }),
    });
    await expect(buildStorefrontDesign({
      shopId: SHOP, request: { prompt: "refills", mode: "auto" }, recipeBuildEnabled: true,
    }, invalid)).rejects.toMatchObject({ code: "storefront_recipe_invalid" });

    const failedProof = dependencies({
      prove: vi.fn().mockResolvedValue({
        ok: false, diagnostics: [{ routeId: "home", code: "bad", message: "bad" }], screenshots: [], browserMs: 1,
      }),
    });
    await expect(buildStorefrontDesign({
      shopId: SHOP, request: { prompt: "refills", mode: "auto" }, recipeBuildEnabled: true,
    }, failedProof)).rejects.toMatchObject({ code: "storefront_recipe_proof_failed" });

    for (const deps of [invalid, failedProof]) {
      expect(deps.createVersion).not.toHaveBeenCalled();
      expect(deps.installDraft).not.toHaveBeenCalled();
    }
  });

  it("does not install when cancellation arrives after immutable version creation", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      createVersion: vi.fn().mockImplementation(async () => {
        controller.abort();
        return VERSION;
      }),
    });

    await expect(buildStorefrontDesign({
      shopId: SHOP,
      request: { prompt: "refills", mode: "auto" },
      recipeBuildEnabled: true,
      signal: controller.signal,
    }, deps)).rejects.toEqual(expect.objectContaining<Partial<StorefrontBuildError>>({
      code: "generation_cancelled",
      status: 409,
    }));
    expect(deps.installDraft).not.toHaveBeenCalled();
  });
});
