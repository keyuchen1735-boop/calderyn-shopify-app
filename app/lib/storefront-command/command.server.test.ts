import { createHash } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { applyStoreIntent } from "./apply";
import { getStoreTemplate } from "../storefront-bundle/registry";
import { CUSTOM_BENCH_BUNDLE } from "../storefront-recipes/custom-bench/bundle";
import { SOFT_CHEMISTRY_BUNDLE } from "../storefront-recipes/soft-chemistry/bundle";
import { STOREFRONT_RECIPES } from "../storefront-recipes";
import { StorefrontReleaseError } from "../storefront-bundle/release.server";
import { storefrontProofContext } from "../storefront-validation/fixtures";
import { proveStorefrontBundle } from "../storefront-validation/browser.server";
import { launchChromium } from "../browser/chromium.server";
import { assembleStorefrontContextWithReferences, type StorefrontContextSource } from "../storefront-ai/context.server";
import { classifyStoreIntent, type StoreIntentProvider } from "./intent.server";
import type { StoreCommand, StoreCommandEvent, StoreCommandReceipt, StoreIntent } from "./types";
import {
  runStoreCommand,
  StoreCommandError,
  type LoadedStoreCommandVersion,
  type StoreCommandDependencies,
  type StoreCommandState,
} from "./command.server";

const SHOP = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const CURRENT = "33333333-3333-3333-3333-333333333333";
const RESULT = "44444444-4444-4444-4444-444444444444";
const TARGET = "55555555-5555-5555-5555-555555555555";
const PRODUCT = "66666666-6666-4666-8666-666666666666";
const PRODUCT_REF = "product-001";
const SECOND_PRODUCT = "77777777-7777-4777-8777-777777777777";
const SECOND_PRODUCT_REF = "product-002";
const HASH = `sha256:${"a".repeat(64)}`;
const RESULT_HASH = `sha256:${"b".repeat(64)}`;

const promptCommand = (
  expectedDraftVersionId: string | null,
  prompt = "Make it calm",
): Extract<StoreCommand, { kind: "prompt" }> => ({
  kind: "prompt",
  prompt,
  expectedDraftVersionId,
});

const resolution = {
  kind: "recipe" as const,
  templateId: "custom-bench" as const,
  templateVersion: 2,
  selectionKind: "niche_match" as const,
  routingVersion: 1,
  registryVersion: 2,
  catalogFingerprint: "sha256:catalog",
  score: 12,
  runnerUpScore: 0,
  margin: 12,
  confidenceBand: "high" as const,
  breakdown: [],
  reasons: ["match"],
};

const context = {
  version: 1 as const,
  prompt: "Make it calm",
  promptHash: `sha256:${"c".repeat(64)}`,
  referenceImages: [],
  store: { name: "Store", logoAssetKey: null, publicBrandAssetKeys: [] },
  collections: [],
  products: [{
    id: "product-a", handle: "a", title: "A", productType: null, tags: [], optionNames: [],
    priceMin: 100, priceMax: 100, currency: "USD", availability: "available" as const, images: [],
  }],
  reusableAssets: [],
  recipeNoveltySignatures: [],
  fingerprint: "sha256:context",
};

const contextAssembly = {
  context,
  references: {
    products: { "product-a": { id: "product-a", handle: "a" } },
    collections: {},
    assets: {},
  },
};

const productlessContextAssembly = {
  context: { ...context, products: [] },
  references: { products: {}, collections: {}, assets: {} },
};

function referencedContextAssembly() {
  const opaqueContext = {
    ...context,
    products: [
      { ...context.products[0]!, id: PRODUCT_REF },
      { ...context.products[0]!, id: SECOND_PRODUCT_REF, handle: "b", title: "B" },
    ],
  };
  return {
    context: opaqueContext,
    references: {
      products: {
        [PRODUCT_REF]: { id: PRODUCT, handle: "a" },
        [SECOND_PRODUCT_REF]: { id: SECOND_PRODUCT, handle: "b" },
      },
      collections: {},
      assets: {},
    },
  };
}

function state(excludedTemplateIds = ["soft-chemistry" as const]) {
  return {
    draft: {
      versionId: CURRENT,
      artifactHash: HASH,
      bundle: structuredClone(CUSTOM_BENCH_BUNDLE),
      resolution: {
        kind: "undo",
        restoredFromVersionId: TARGET,
        undoneVersionId: RESULT,
        excludedTemplateIds,
      },
    },
    publishedVersionId: TARGET,
  };
}

function dependencies(overrides: Partial<StoreCommandDependencies> = {}): StoreCommandDependencies {
  return {
    loadState: vi.fn().mockResolvedValue({ draft: null, publishedVersionId: null }),
    assertWriteAllowed: vi.fn().mockResolvedValue(undefined),
    assertPublishable: vi.fn().mockResolvedValue(undefined),
    readEnabled: () => true,
    recipeBuildEnabled: () => true,
    publishEnabled: () => true,
    buildEvidence: vi.fn().mockResolvedValue({
      productTitles: [], productTypes: [], productTags: [], optionNames: [], collectionTitles: [], fingerprint: "sha256:catalog",
    }),
    loadReferenceImages: vi.fn().mockResolvedValue([]),
    loadContext: vi.fn().mockResolvedValue(contextAssembly),
    prepareProductMedia: vi.fn().mockResolvedValue(0),
    classify: vi.fn().mockResolvedValue({ kind: "select_design", prompt: "Make it calm", excludedTemplateIds: [] }),
    resolveDesign: vi.fn().mockReturnValue(resolution),
    loadRecipe: vi.fn().mockResolvedValue({
      bundle: structuredClone(CUSTOM_BENCH_BUNDLE),
      report: { profileVersion: 1, ok: true, diagnostics: [] },
    }),
    applyIntent: vi.fn((bundle) => ({ bundle: { ...structuredClone(bundle), featuredProductIds: ["product-a"] } })),
    validate: vi.fn().mockReturnValue({ profileVersion: 1, ok: true, diagnostics: [] }),
    prove: vi.fn().mockResolvedValue({ ok: true, diagnostics: [], screenshots: ["proof"], browserMs: 1 }),
    hashArtifact: vi.fn().mockResolvedValue(RESULT_HASH),
    createVersion: vi.fn().mockResolvedValue(RESULT),
    install: vi.fn().mockResolvedValue(RESULT),
    edit: vi.fn().mockResolvedValue(RESULT),
    undo: vi.fn().mockResolvedValue({ status: "installed", versionId: RESULT, undoneVersionId: CURRENT }),
    publish: vi.fn().mockResolvedValue(CURRENT),
    ...overrides,
  };
}

describe("runStoreCommand", () => {
  it("installs a fresh hidden design only after proof and emits no design identifiers", async () => {
    const deps = dependencies();
    const events: StoreCommandEvent[] = [];

    const receipt = await runStoreCommand({
      shopId: SHOP,
      actorId: USER,
      command: promptCommand(null),
      onEvent: (event) => { events.push(event); },
    }, deps);

    expect(deps.prepareProductMedia).toHaveBeenCalledWith(SHOP, undefined);
    expect(vi.mocked(deps.prepareProductMedia).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.loadContext).mock.invocationCallOrder[0]!,
    );
    expect(deps.resolveDesign).toHaveBeenCalledWith(expect.objectContaining({ excludedTemplateIds: [] }), expect.anything());
    expect(deps.classify).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Make it calm",
      productCandidates: [{ id: "product-a", title: "A" }],
    }));
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.install).mock.invocationCallOrder[0]!);
    expect(deps.install).toHaveBeenCalledWith({
      shopId: SHOP, versionId: RESULT, expectedDraftVersionId: null, actorId: USER,
    });
    const provedBundle = vi.mocked(deps.prove).mock.calls[0]![0].bundle;
    expect(vi.mocked(deps.prove).mock.calls[0]![0]).not.toHaveProperty("routes");
    const persistedArtifact = vi.mocked(deps.createVersion).mock.calls[0]![0].artifact as { bundle: unknown };
    expect(persistedArtifact.bundle).toBe(provedBundle);
    expect(vi.mocked(deps.createVersion).mock.calls[0]![0]).toMatchObject({
      templateId: provedBundle.source.kind === "recipe" ? provedBundle.source.templateId : undefined,
      templateVersion: provedBundle.source.kind === "recipe" ? provedBundle.source.templateVersion : undefined,
    });
    expect(receipt).toEqual({ status: "installed", versionId: RESULT, undo: null });
    expect(events.map(({ stage }) => stage)).toEqual(["understanding", "preparing_products", "checking_preview", "ready"]);
    expect(JSON.stringify(events)).not.toContain("custom-bench");
  });

  it.each([
    { kind: "unsupported", message: "No safe change." },
    { kind: "update_text", slot: "heroTitle", value: "New title" },
    { kind: "update_merchandising", productIds: ["product-a"] },
    { kind: "update_visual_layer", visualLayer: { kind: "none" } },
  ] as const)("leaves a fresh store unchanged for $kind intent", async (intent) => {
    const deps = dependencies({ classify: vi.fn().mockResolvedValue(intent) });

    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null) }, deps))
      .resolves.toMatchObject({ status: "unchanged" });

    expect(deps.resolveDesign).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.edit).not.toHaveBeenCalled();
  });

  it.each(["Undo", "Publish"])("does not treat fresh-store %s text as a design request", async (prompt) => {
    const deps = dependencies({
      classify: vi.fn().mockResolvedValue({ kind: "unsupported", message: "Use the dedicated control." }),
    });

    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null, prompt) }, deps))
      .resolves.toMatchObject({ status: "unchanged" });
    expect(deps.resolveDesign).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("does not let a fresh-store start_over intent create the first draft", async () => {
    const deps = dependencies({
      classify: vi.fn().mockResolvedValue({ kind: "start_over", prompt: "Start over" }),
    });

    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null, "Start over") }, deps))
      .resolves.toMatchObject({ status: "unchanged" });
    expect(deps.resolveDesign).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("applies a bounded fresh-store shader after selecting an approved design", async () => {
    const source = "void main(){gl_FragColor=vec4(1.);}";
    const deps = dependencies({
      classify: vi.fn().mockResolvedValue({
        kind: "select_design",
        prompt: "Use this shader",
        excludedTemplateIds: [],
      }),
      applyIntent: applyStoreIntent,
    });
    const command = {
      ...promptCommand(null, "Use this shader"),
      attachments: [{ kind: "fragment_shader" as const, source }],
    };

    await expect(runStoreCommand({ shopId: SHOP, command }, deps)).resolves.toMatchObject({ status: "installed" });
    expect(deps.classify).toHaveBeenCalledWith(expect.objectContaining({ attachments: command.attachments }));
    expect(vi.mocked(deps.prove).mock.calls[0]![0].bundle.visualLayer).toEqual({
      kind: "fragment_shader",
      source,
      colors: ["#000000", "#ffffff", "#888888"],
    });
    expect(deps.install).toHaveBeenCalledOnce();
  });

  it("does not partially apply a compound edit classified as unsupported", async () => {
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue({
        kind: "unsupported",
        message: "Please make one storefront change at a time.",
      }),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: promptCommand(CURRENT, "Change the title and feature the jacket"),
    }, deps)).resolves.toMatchObject({ status: "unchanged" });
    expect(deps.applyIntent).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.edit).not.toHaveBeenCalled();
  });

  it("keeps a compound edit non-writing through the real classifier boundary", async () => {
    const provider = vi.fn(async (request: Parameters<StoreIntentProvider>[0]) => {
      expect(request.system).toContain("requestedOperations");
      return JSON.stringify({
        requestedOperations: ["update_text", "update_merchandising"],
        intent: { kind: "update_text", slot: "heroTitle", value: "Only the first edit" },
      });
    });
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: (classificationInput, options) =>
        classifyStoreIntent(classificationInput, { provider }, options),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: promptCommand(CURRENT, "Change the title and feature the jacket"),
    }, deps)).resolves.toMatchObject({ status: "unchanged" });
    expect(provider).toHaveBeenCalledOnce();
    expect(deps.applyIntent).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.edit).not.toHaveBeenCalled();
  });

  it("omits the unreachable product route from fresh zero-product proof", async () => {
    const deps = dependencies({ loadContext: vi.fn().mockResolvedValue(productlessContextAssembly) });

    await runStoreCommand({ shopId: SHOP, command: promptCommand(null) }, deps);

    expect(deps.prove).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ products: [] }),
      routes: ["home", "collection", "search", "cart", "checkout"],
    }));
  });

  it("omits the unreachable product route from follow-up zero-product proof", async () => {
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      loadContext: vi.fn().mockResolvedValue(productlessContextAssembly),
      classify: vi.fn().mockResolvedValue({ kind: "update_text", slot: "heroTitle", value: "New title" }),
      applyIntent: vi.fn((bundle) => ({
        bundle: {
          ...structuredClone(bundle),
          visualLayer: { kind: "fragment_shader", source: "void main(){gl_FragColor=vec4(1.);}", colors: ["#000000", "#ffffff", "#888888"] },
        },
      })),
    });

    await runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT) }, deps);

    expect(deps.prove).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ products: [] }),
      routes: ["home", "collection", "search", "cart", "checkout"],
    }));
    expect(deps.edit).toHaveBeenCalledOnce();
  });

  it("rejects a stale expected draft before classification or proof spend", async () => {
    const deps = dependencies({ loadState: vi.fn().mockResolvedValue(state()) });

    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(TARGET) }, deps))
      .rejects.toMatchObject({ code: "storefront_command_conflict", status: 409 });

    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
  });

  it("feeds persisted Undo exclusions into the next design selection", async () => {
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue({
        kind: "select_design", prompt: "editorial", excludedTemplateIds: ["soft-chemistry", "custom-bench"],
      }),
    });

    const receipt = await runStoreCommand({ shopId: SHOP, actorId: USER, command: promptCommand(CURRENT, "Try another") }, deps);

    expect(deps.classify).toHaveBeenCalledWith(expect.objectContaining({
      excludedTemplateIds: ["soft-chemistry"], currentTemplateId: "custom-bench",
    }));
    expect(deps.resolveDesign).toHaveBeenCalledWith(expect.objectContaining({
      excludedTemplateIds: ["soft-chemistry", "custom-bench"],
    }), expect.anything());
    expect(deps.edit).toHaveBeenCalledWith(expect.objectContaining({
      baseVersionId: CURRENT,
      resultVersionId: RESULT,
      expectedDraftVersionId: CURRENT,
      baseArtifactHash: HASH,
      resultArtifactHash: RESULT_HASH,
      validation: expect.objectContaining({ browserProof: expect.objectContaining({ ok: true }) }),
    }));
    expect(deps.install).not.toHaveBeenCalled();
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
    expect(receipt).toEqual({
      status: "installed", versionId: RESULT,
      undo: { targetVersionId: CURRENT, expectedDraftVersionId: RESULT },
    });
    expect(vi.mocked(deps.createVersion).mock.calls[0]?.[0].resolution).toEqual(expect.objectContaining({
      excludedTemplateIds: ["soft-chemistry", "custom-bench"],
    }));
    expect(Object.keys(deps)).not.toContain("compileStructuralPatch");
  });

  it("carries explicit exclusions through a non-exact start-over request", async () => {
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue({
        kind: "start_over",
        prompt: "Start over, but not Soft Chemistry",
      }),
    });

    await runStoreCommand({
      shopId: SHOP,
      command: promptCommand(CURRENT, "Start over, but not Soft Chemistry"),
    }, deps);

    expect(deps.resolveDesign).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Start over, but not Soft Chemistry",
      excludedTemplateIds: ["soft-chemistry", "custom-bench"],
    }), expect.anything());
  });

  it.each([
    ["select_design", "Switch design", { kind: "select_design" as const, prompt: "Switch design", excludedTemplateIds: ["custom-bench" as const] }],
    ["Try another", "Try another", { kind: "select_design" as const, prompt: "Try another", excludedTemplateIds: ["custom-bench" as const] }],
    ["Start over", "Start over", { kind: "start_over" as const, prompt: "Start over" }],
  ])("carries only compatible declared overrides through %s", async (_label, prompt, intent) => {
    let currentBundle = applyStoreIntent(
      CUSTOM_BENCH_BUNDLE,
      getStoreTemplate("custom-bench"),
      { kind: "update_text", slot: "heroTitle", value: "Merchant hero copy" },
    ).bundle;
    currentBundle = applyStoreIntent(currentBundle, getStoreTemplate("custom-bench"), {
      kind: "update_merchandising",
      productIds: ["product-a", "no-longer-owned"],
    }).bundle;
    const visualLayer = {
      kind: "fragment_shader" as const,
      source: "void main(){gl_FragColor=vec4(1.);}",
      colors: ["#000000", "#111111", "#222222"] as [string, string, string],
    };
    currentBundle = applyStoreIntent(currentBundle, getStoreTemplate("custom-bench"), {
      kind: "update_visual_layer",
      visualLayer,
    }).bundle;
    const current = state([]);
    current.draft!.bundle = currentBundle;
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(current),
      classify: vi.fn().mockResolvedValue(intent),
      resolveDesign: vi.fn().mockReturnValue({
        ...resolution,
        templateId: "soft-chemistry",
        templateVersion: 5,
      }),
      loadRecipe: vi.fn().mockResolvedValue({
        bundle: structuredClone(SOFT_CHEMISTRY_BUNDLE),
        report: { profileVersion: 1, ok: true, diagnostics: [] },
      }),
      applyIntent: applyStoreIntent,
    });

    await runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT, prompt) }, deps);

    const carried = vi.mocked(deps.prove).mock.calls[0]![0].bundle;
    expect(carried.source).toMatchObject({ kind: "recipe", templateId: "soft-chemistry" });
    expect(carried.routes.home.html).toContain("Merchant hero copy");
    expect(carried.featuredProductIds).toEqual(["product-a"]);
    expect(carried.visualLayer).toEqual(visualLayer);
  });

  it("installs an explicitly named design verbatim instead of carrying old design copy", async () => {
    const currentBundle = applyStoreIntent(
      CUSTOM_BENCH_BUNDLE,
      getStoreTemplate("custom-bench"),
      { kind: "update_text", slot: "heroTitle", value: "Merchant hero copy" },
    ).bundle;
    const current = state([]);
    current.draft!.bundle = currentBundle;
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(current),
      classify: vi.fn().mockResolvedValue({
        kind: "select_design",
        prompt: "Use Soft Chemistry",
        excludedTemplateIds: ["custom-bench"],
      }),
      resolveDesign: vi.fn().mockReturnValue({
        ...resolution,
        templateId: "soft-chemistry",
        templateVersion: 5,
      }),
      loadRecipe: vi.fn().mockResolvedValue({
        bundle: structuredClone(SOFT_CHEMISTRY_BUNDLE),
        report: { profileVersion: 1, ok: true, diagnostics: [] },
      }),
      applyIntent: applyStoreIntent,
    });

    await runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT, "Use Soft Chemistry") }, deps);

    const installed = vi.mocked(deps.prove).mock.calls[0]![0].bundle;
    expect(installed.routes.home.html).toContain("Skin, in its softer state.");
    expect(installed.routes.home.html).not.toContain("Merchant hero copy");
  });

  it("returns unchanged without a write for exhausted, unsupported, and no-op commands", async () => {
    const exhausted = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue({ kind: "select_design", prompt: "another", excludedTemplateIds: ["custom-bench"] }),
      resolveDesign: vi.fn().mockReturnValue({
        kind: "no_match", reason: "all_designs_excluded", routingVersion: 1, registryVersion: 1,
        catalogFingerprint: "sha256:catalog", breakdown: [], reasons: ["none"],
      }),
    });
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT) }, exhausted))
      .resolves.toMatchObject({ status: "unchanged" });

    const unsupported = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue({
        kind: "unsupported",
        message: "Internal template custom-bench could not read bundle_json.",
      }),
    });
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT) }, unsupported))
      .resolves.toEqual({
        status: "unchanged",
        message: "I couldn't apply that request safely, so your draft was left unchanged.",
      });

    const noOp = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue({ kind: "update_merchandising", productIds: ["product-a"] }),
      applyIntent: vi.fn((bundle) => ({ bundle: structuredClone(bundle) })),
    });
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT) }, noOp))
      .resolves.toMatchObject({ status: "unchanged" });

    for (const deps of [exhausted, unsupported, noOp]) {
      expect(deps.prove).not.toHaveBeenCalled();
      expect(deps.hashArtifact).not.toHaveBeenCalled();
      expect(deps.createVersion).not.toHaveBeenCalled();
      expect(deps.install).not.toHaveBeenCalled();
      expect(deps.edit).not.toHaveBeenCalled();
    }
  });

  it.each([
    { kind: "update_text", slot: "heroTitle", value: "Summer starts here" },
    { kind: "update_merchandising", productIds: ["product-a"] },
    { kind: "update_visual_layer", visualLayer: { kind: "none" } },
  ] as const)("validates, proves, and audits $kind", async (intent) => {
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue(intent),
    });

    await runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT) }, deps);

    expect(deps.applyIntent).toHaveBeenCalledWith(expect.anything(), expect.anything(), intent);
    expect(deps.validate).toHaveBeenCalledBefore(vi.mocked(deps.prove));
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
    expect(deps.edit).toHaveBeenCalledOnce();
  });

  it("persists owned product IDs after classifying opaque product references", async () => {
    const contextAssembly = referencedContextAssembly();
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      loadContext: vi.fn().mockResolvedValue(contextAssembly),
      classify: vi.fn().mockResolvedValue({
        kind: "update_merchandising",
        productIds: [SECOND_PRODUCT_REF, PRODUCT_REF],
      }),
      applyIntent: vi.fn((bundle, _template, intent) => ({
        bundle: {
          ...structuredClone(bundle),
          featuredProductIds: intent.kind === "update_merchandising" ? intent.productIds : [],
        },
      })),
    });

    await runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT) }, deps);

    expect(deps.classify).toHaveBeenCalledWith(expect.objectContaining({
      productCandidates: [
        { id: PRODUCT_REF, title: "A" },
        { id: SECOND_PRODUCT_REF, title: "B" },
      ],
    }));
    expect(deps.applyIntent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { kind: "update_merchandising", productIds: [SECOND_PRODUCT, PRODUCT] },
    );
    expect(vi.mocked(deps.prove).mock.calls[0]![0]).toMatchObject({
      bundle: { featuredProductIds: [SECOND_PRODUCT, PRODUCT] },
      context: { products: [{ id: PRODUCT }, { id: SECOND_PRODUCT }] },
    });
    expect(vi.mocked(deps.createVersion).mock.calls[0]![0].artifact).toMatchObject({
      bundle: { featuredProductIds: [SECOND_PRODUCT, PRODUCT] },
    });
  });

  it("selects the 61st owned product through real context assembly and classification", async () => {
    const sourceProducts = storefrontProofContext().products.map((product, index) => ({
      ...product,
      id: `owned-product-${String(index + 1).padStart(3, "0")}`,
      title: `Catalog Product ${index + 1}`,
      collectionIds: [],
    }));
    const target = sourceProducts[60]!;
    const source: StorefrontContextSource = {
      getStore: async () => ({ name: "Store", logoAssetKey: null, publicBrandAssetKeys: [] }),
      listCollections: async () => [],
      listProducts: async (_shopId, limit) => sourceProducts.slice(0, limit),
      listReusableAssets: async () => [],
    };
    let providerInput = "";
    const provider = vi.fn(async (request: { prompt: string }) => {
      providerInput = request.prompt;
      return JSON.stringify({
        requestedOperations: ["update_merchandising"],
        intent: { kind: "update_merchandising", productIds: ["product-061"] },
      });
    });
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      loadContext: (input) => assembleStorefrontContextWithReferences(input, source),
      classify: (input, options) => classifyStoreIntent(input, { provider }, options),
      applyIntent: applyStoreIntent,
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: promptCommand(CURRENT, "Feature Catalog Product 61"),
    }, deps)).resolves.toMatchObject({ status: "installed" });

    const candidates = (JSON.parse(providerInput) as {
      productCandidates: Array<{ id: string; title: string }>;
    }).productCandidates;
    expect(candidates).toHaveLength(61);
    expect(candidates[60]).toEqual({ id: "product-061", title: target.title });
    expect(providerInput).not.toContain("owned-product-");
    expect(vi.mocked(deps.createVersion).mock.calls[0]![0].artifact).toMatchObject({
      bundle: { featuredProductIds: [target.id] },
    });
  });

  it("loads and proves existing featured products outside the ordinary sample for a text edit", async () => {
    const current = state();
    current.draft!.bundle.featuredProductIds = [SECOND_PRODUCT, PRODUCT];
    const requiredAssembly = referencedContextAssembly();
    const loadContext = vi.fn(async (input: { requiredProductIds?: string[] }) =>
      input.requiredProductIds?.length ? requiredAssembly : contextAssembly);
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(current),
      loadContext,
      classify: vi.fn().mockResolvedValue({ kind: "update_text", slot: "heroTitle", value: "New title" }),
      applyIntent: vi.fn((bundle) => ({
        bundle: {
          ...structuredClone(bundle),
          visualLayer: { kind: "fragment_shader", source: "void main(){gl_FragColor=vec4(1.);}", colors: ["#000000", "#ffffff", "#888888"] },
        },
      })),
    });

    await runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT, "Update the headline") }, deps);

    expect(loadContext).toHaveBeenCalledWith(expect.objectContaining({
      requiredProductIds: [SECOND_PRODUCT, PRODUCT],
    }));
    expect(vi.mocked(deps.prove).mock.calls[0]![0]).toMatchObject({
      bundle: { featuredProductIds: [SECOND_PRODUCT, PRODUCT] },
      context: { products: [{ id: PRODUCT }, { id: SECOND_PRODUCT }] },
    });
  });

  it("fails closed when an existing featured product is unavailable", async () => {
    const current = state();
    current.draft!.bundle.featuredProductIds = [SECOND_PRODUCT];
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(current),
      loadContext: vi.fn().mockResolvedValue(contextAssembly),
      classify: vi.fn().mockResolvedValue({ kind: "update_text", slot: "heroTitle", value: "New title" }),
      applyIntent: vi.fn((bundle) => ({
        bundle: {
          ...structuredClone(bundle),
          visualLayer: { kind: "fragment_shader", source: "void main(){gl_FragColor=vec4(1.);}", colors: ["#000000", "#ffffff", "#888888"] },
        },
      })),
    });

    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT, "Update the headline") }, deps))
      .rejects.toMatchObject({ code: "storefront_command_rejected", status: 422 });
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.edit).not.toHaveBeenCalled();
  });

  it("rejects an unmapped product reference before proof or persistence", async () => {
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      loadContext: vi.fn().mockResolvedValue(referencedContextAssembly()),
      classify: vi.fn().mockResolvedValue({ kind: "update_merchandising", productIds: ["product-999"] }),
    });

    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT) }, deps))
      .rejects.toMatchObject({ code: "storefront_command_rejected", status: 422 });

    expect(deps.applyIntent).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.edit).not.toHaveBeenCalled();
  });

  it("routes Start over through recipe selection and Undo/Publish through release primitives", async () => {
    const start = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue({ kind: "start_over", prompt: "Start over" }),
    });
    await runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT, "Start over") }, start);
    expect(start.resolveDesign).toHaveBeenCalled();
    expect(start.edit).toHaveBeenCalledOnce();

    const undo = dependencies({ loadState: vi.fn().mockResolvedValue(state()) });
    const undoController = new AbortController();
    await expect(runStoreCommand({
      shopId: SHOP,
      command: { kind: "undo", targetVersionId: TARGET, expectedDraftVersionId: CURRENT },
      signal: undoController.signal,
    }, undo)).resolves.toEqual({
      status: "installed", versionId: RESULT,
      undo: { targetVersionId: CURRENT, expectedDraftVersionId: RESULT },
    });
    expect(undo.undo).toHaveBeenCalledWith({
      shopId: SHOP, actorId: null, targetVersionId: TARGET, expectedDraftVersionId: CURRENT,
      signal: undoController.signal,
    });

    const publish = dependencies({ loadState: vi.fn().mockResolvedValue(state()) });
    const publishController = new AbortController();
    await expect(runStoreCommand({
      shopId: SHOP,
      command: { kind: "publish", expectedDraftVersionId: CURRENT },
      signal: publishController.signal,
    }, publish)).resolves.toEqual({ status: "published", versionId: CURRENT });
    expect(publish.publish).toHaveBeenCalledWith({
      shopId: SHOP, actorId: null, expectedDraftVersionId: CURRENT, expectedPublishedVersionId: TARGET,
      signal: publishController.signal,
    });
  });

  it("enforces recipe and publish switches plus tenant publishability", async () => {
    const readDisabled = dependencies({ readEnabled: () => false });
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null) }, readDisabled))
      .rejects.toMatchObject({ code: "storefront_command_unavailable", status: 503 });
    expect(readDisabled.resolveDesign).not.toHaveBeenCalled();

    const recipeDisabled = dependencies({ recipeBuildEnabled: () => false });
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null) }, recipeDisabled))
      .rejects.toMatchObject({ code: "storefront_command_unavailable", status: 503 });
    expect(recipeDisabled.resolveDesign).not.toHaveBeenCalled();

    const publishDisabled = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      publishEnabled: () => false,
    });
    await expect(runStoreCommand({
      shopId: SHOP,
      command: { kind: "publish", expectedDraftVersionId: CURRENT },
    }, publishDisabled)).rejects.toMatchObject({ code: "storefront_command_unavailable", status: 503 });
    expect(publishDisabled.publish).not.toHaveBeenCalled();

    const publishWithoutRecipeWrites = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      recipeBuildEnabled: () => false,
    });
    await expect(runStoreCommand({
      shopId: SHOP,
      command: { kind: "publish", expectedDraftVersionId: CURRENT },
    }, publishWithoutRecipeWrites)).rejects.toMatchObject({ code: "storefront_command_unavailable", status: 503 });
    expect(publishWithoutRecipeWrites.publish).not.toHaveBeenCalled();

    const domainFailure = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      assertPublishable: vi.fn().mockRejectedValue(Object.assign(new Error("domain"), {
        code: "storefront_domain_registration_failed", status: 503,
      })),
    });
    await expect(runStoreCommand({
      shopId: SHOP,
      command: { kind: "publish", expectedDraftVersionId: CURRENT },
    }, domainFailure)).rejects.toMatchObject({ code: "storefront_command_failed", status: 500 });
    expect(domainFailure.publish).not.toHaveBeenCalled();
  });

  it("keeps a trusted unavailable state distinct from a CAS conflict", async () => {
    const deps = dependencies({
      loadState: vi.fn().mockRejectedValue(new StoreCommandError(
        "storefront_command_unavailable",
        "This storefront draft cannot be changed with chat yet.",
        503,
      )),
    });
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT) }, deps))
      .rejects.toMatchObject({ code: "storefront_command_unavailable", status: 503 });
  });

  it("passes a verified design reference into multimodal classification and routes its selected prompt", async () => {
    const assetRef = `${SHOP}/upload/reference.webp`;
    const publicUrl = "https://assets.example/reference.webp";
    const deps = dependencies({
      loadReferenceImages: vi.fn().mockResolvedValue([{
        assetKey: assetRef,
        publicUrl,
        mediaType: "image/webp",
      }]),
      classify: vi.fn().mockResolvedValue({
        kind: "select_design",
        prompt: "soft editorial skincare",
        excludedTemplateIds: [],
      }),
    });
    const command = {
      ...promptCommand(null),
      attachments: [{ kind: "design_reference" as const, assetRef }],
    };

    await expect(runStoreCommand({ shopId: SHOP, command }, deps)).resolves.toMatchObject({ status: "installed" });
    expect(deps.loadReferenceImages).toHaveBeenCalledWith(SHOP, [assetRef]);
    expect(deps.classify).toHaveBeenCalledWith(expect.objectContaining({
      attachments: command.attachments,
      referenceImages: [{ url: publicUrl, mediaType: "image/webp" }],
    }));
    expect(deps.loadContext).toHaveBeenCalledWith(expect.objectContaining({
      referenceImages: [{ assetKey: assetRef, mediaType: "image/webp" }],
    }));
    expect(deps.resolveDesign).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "soft editorial skincare",
    }), expect.anything());
    expect(deps.createVersion).toHaveBeenCalledOnce();
  });

  it("rejects a fabricated same-shop design reference before context or classification", async () => {
    const assetRef = `${SHOP}/missing.webp`;
    const deps = dependencies({
      loadReferenceImages: vi.fn().mockRejectedValue(new StoreCommandError(
        "storefront_command_invalid",
        "That design reference is not owned by this store.",
        422,
      )),
    });
    const command = {
      ...promptCommand(null),
      attachments: [{ kind: "design_reference" as const, assetRef }],
    };

    await expect(runStoreCommand({ shopId: SHOP, command }, deps))
      .rejects.toMatchObject({ code: "storefront_command_rejected", status: 422 });
    expect(deps.loadReferenceImages).toHaveBeenCalledWith(SHOP, [assetRef]);
    expect(deps.loadContext).not.toHaveBeenCalled();
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
  });

  it("rejects a cross-shop design reference through the owned-asset loader", async () => {
    const assetRef = "99999999-9999-4999-8999-999999999999/upload/reference.webp";
    const deps = dependencies({
      loadReferenceImages: vi.fn().mockRejectedValue(new StoreCommandError(
        "storefront_command_invalid",
        "That design reference is not owned by this store.",
        422,
      )),
    });
    const command = {
      ...promptCommand(null),
      attachments: [{ kind: "design_reference" as const, assetRef }],
    };

    await expect(runStoreCommand({ shopId: SHOP, command }, deps))
      .rejects.toMatchObject({ code: "storefront_command_rejected", status: 422 });
    expect(deps.loadReferenceImages).toHaveBeenCalledWith(SHOP, [assetRef]);
    expect(deps.loadContext).not.toHaveBeenCalled();
    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
  });

  it("never writes on pre-abort, static failure, or proof failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = dependencies();
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null), signal: controller.signal }, aborted))
      .rejects.toMatchObject({ code: "generation_cancelled" });

    const invalid = dependencies({
      validate: vi.fn().mockReturnValue({ profileVersion: 1, ok: false, diagnostics: [{ code: "bad", path: "home", message: "bad" }] }),
    });
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null) }, invalid))
      .rejects.toMatchObject({ code: "storefront_command_rejected", status: 422 });

    const failedProof = dependencies({
      prove: vi.fn().mockResolvedValue({ ok: false, diagnostics: [{ routeId: "home", code: "bad", message: "bad" }], screenshots: [], browserMs: 1 }),
    });
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null) }, failedProof))
      .rejects.toMatchObject({ code: "storefront_command_rejected", status: 422 });

    for (const deps of [aborted, invalid, failedProof]) {
      expect(deps.createVersion).not.toHaveBeenCalled();
      expect(deps.install).not.toHaveBeenCalled();
      expect(deps.edit).not.toHaveBeenCalled();
    }
  });

  it("maps intent-classification rejection to actionable 422 copy, not the generic failure", async () => {
    const deps = dependencies({
      classify: vi.fn().mockRejectedValue(
        Object.assign(new Error("The store request could not be safely understood."), {
          code: "invalid_store_intent",
        }),
      ),
    });
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null) }, deps))
      .rejects.toMatchObject({
        code: "storefront_command_rejected",
        status: 422,
        message: expect.stringContaining("one change at a time"),
      });
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("does not install when cancellation arrives after immutable version creation", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      createVersion: vi.fn().mockImplementation(async () => {
        controller.abort();
        return RESULT;
      }),
    });

    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(null), signal: controller.signal }, deps))
      .rejects.toMatchObject({ code: "generation_cancelled" });
    expect(deps.install).not.toHaveBeenCalled();
    expect(deps.edit).not.toHaveBeenCalled();
  });

  it("cuts off an existing-draft change when preview proof observes cancellation", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue({ kind: "update_merchandising", productIds: ["product-a"] }),
      prove: vi.fn().mockImplementation(async () => {
        controller.abort();
        return { ok: true, diagnostics: [], screenshots: ["proof"], browserMs: 1 };
      }),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: promptCommand(CURRENT),
      signal: controller.signal,
    }, deps)).rejects.toMatchObject({ code: "generation_cancelled" });
    expect(deps.hashArtifact).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.edit).not.toHaveBeenCalled();
  });

  it("passes cancellation into intent classification before any write", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const classificationStarted = new Promise<void>((resolve) => { started = resolve; });
    let receivedSignal: AbortSignal | undefined;
    let releaseClassification!: (intent: {
      kind: "select_design";
      prompt: string;
      excludedTemplateIds: [];
    }) => void;
    const deps = dependencies({
      classify: vi.fn((_request, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        started();
        return new Promise<StoreIntent>((resolve) => { releaseClassification = resolve; });
      }),
    });
    const pending = runStoreCommand({
      shopId: SHOP,
      command: promptCommand(null),
      signal: controller.signal,
    }, deps);

    await classificationStarted;
    controller.abort(new DOMException("Stopped", "AbortError"));
    releaseClassification({ kind: "select_design", prompt: "Make it calm", excludedTemplateIds: [] });

    await expect(pending).rejects.toMatchObject({ code: "generation_cancelled" });
    expect(receivedSignal).toBe(controller.signal);
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("returns committed success when cancellation races with fresh terminal install", async () => {
    const controller = new AbortController();
    const events: StoreCommandEvent[] = [];
    const deps = dependencies({
      install: vi.fn().mockImplementation(async () => {
        controller.abort();
        return RESULT;
      }),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: promptCommand(null),
      signal: controller.signal,
      onEvent: (event) => { events.push(event); },
    }, deps)).resolves.toEqual({ status: "installed", versionId: RESULT, undo: null });
    expect(events.at(-1)).toEqual({
      stage: "ready",
      receipt: { status: "installed", versionId: RESULT, undo: null },
    });
  });

  it("returns committed success when cancellation races with existing terminal edit", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      classify: vi.fn().mockResolvedValue({ kind: "update_merchandising", productIds: ["product-a"] }),
      edit: vi.fn().mockImplementation(async () => {
        controller.abort();
        return RESULT;
      }),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: promptCommand(CURRENT),
      signal: controller.signal,
    }, deps)).resolves.toEqual({
      status: "installed",
      versionId: RESULT,
      undo: { targetVersionId: CURRENT, expectedDraftVersionId: RESULT },
    });
  });

  it("returns committed success when cancellation races with terminal Undo", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      undo: vi.fn().mockImplementation(async () => {
        controller.abort();
        return { status: "installed" as const, versionId: RESULT, undoneVersionId: CURRENT };
      }),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: { kind: "undo", targetVersionId: TARGET, expectedDraftVersionId: CURRENT },
      signal: controller.signal,
    }, deps)).resolves.toMatchObject({ status: "installed", versionId: RESULT });
  });

  it("returns committed success when cancellation races with terminal Publish", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      publish: vi.fn().mockImplementation(async () => {
        controller.abort();
        return CURRENT;
      }),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: { kind: "publish", expectedDraftVersionId: CURRENT },
      signal: controller.signal,
    }, deps)).resolves.toEqual({ status: "published", versionId: CURRENT });
  });

  it("maps unknown upstream failures to one fixed merchant-safe stream error", async () => {
    const events: StoreCommandEvent[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = dependencies({
      loadState: vi.fn().mockRejectedValue(Object.assign(
        new Error("bundle_json leaked custom-bench service_role"),
        { code: "postgres_private_recipe_failure", status: 418 },
      )),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: promptCommand(null),
      onEvent: (event) => { events.push(event); },
    }, deps)).rejects.toMatchObject({
      code: "storefront_command_failed",
      status: 500,
      message: "The storefront change could not be completed. Your current draft was not changed.",
    });
    expect(events).toEqual([{
      stage: "error",
      code: "storefront_command_failed",
      status: 500,
      message: "The storefront change could not be completed. Your current draft was not changed.",
    }]);
    expect(JSON.stringify(events)).not.toMatch(/bundle_json|custom-bench|service_role|postgres_private_recipe_failure/);
    expect(logged).toHaveBeenCalledWith(
      "[storefront-command] unexpected failure",
      expect.objectContaining({ shopId: SHOP, commandKind: "prompt", error: expect.any(Error) }),
    );
    logged.mockRestore();
  });

  it("maps release CAS failures to the fixed public conflict error", async () => {
    const events: StoreCommandEvent[] = [];
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      publish: vi.fn().mockRejectedValue(Object.assign(
        new Error("storefront_publish_conflict at private.release row"),
        { code: "storefront_publish_conflict", status: 409 },
      )),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: { kind: "publish", expectedDraftVersionId: CURRENT },
      onEvent: (event) => { events.push(event); },
    }, deps)).rejects.toMatchObject({
      code: "storefront_command_conflict",
      status: 409,
      message: "The storefront changed before this request. Refresh and try again.",
    });
    expect(events.at(-1)).toEqual({
      stage: "error",
      code: "storefront_command_conflict",
      status: 409,
      message: "The storefront changed before this request. Refresh and try again.",
    });
    expect(JSON.stringify(events)).not.toMatch(/private\.release|storefront_publish_conflict/);
  });

  it("maps a trusted 409 fallback from SQLSTATE 40001 to the fixed public conflict", async () => {
    const deps = dependencies({
      loadState: vi.fn().mockResolvedValue(state()),
      publish: vi.fn().mockRejectedValue(new StorefrontReleaseError(
        "storefront_publish_failed",
        "serialization failure in private release row",
        409,
        { code: "40001" },
      )),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: { kind: "publish", expectedDraftVersionId: CURRENT },
    }, deps)).rejects.toMatchObject({
      code: "storefront_command_conflict",
      status: 409,
      message: "The storefront changed before this request. Refresh and try again.",
    });
  });

  it.each([
    ["template ID", (bundle: typeof CUSTOM_BENCH_BUNDLE) => {
      if (bundle.source.kind !== "recipe") throw new Error("recipe fixture required");
      bundle.source.templateId = "soft-chemistry";
    }],
    ["template version", (bundle: typeof CUSTOM_BENCH_BUNDLE) => {
      if (bundle.source.kind !== "recipe") throw new Error("recipe fixture required");
      bundle.source.templateVersion = 3;
    }],
    ["source kind", (bundle: typeof CUSTOM_BENCH_BUNDLE) => {
      bundle.source = { kind: "custom", generationId: "mismatch", promptHash: "sha256:mismatch" };
    }],
  ] as const)("rejects a recipe whose immutable %s does not match the selected resolution", async (_case, mutate) => {
    const mismatched = structuredClone(CUSTOM_BENCH_BUNDLE);
    mutate(mismatched);
    const events: StoreCommandEvent[] = [];
    const deps = dependencies({
      loadRecipe: vi.fn().mockResolvedValue({
        bundle: mismatched,
        report: { profileVersion: 1, ok: true, diagnostics: [] },
      }),
    });

    await expect(runStoreCommand({
      shopId: SHOP,
      command: promptCommand(null),
      onEvent: (event) => { events.push(event); },
    }, deps)).rejects.toMatchObject({ code: "storefront_command_failed", status: 500 });
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.install).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toMatch(/custom-bench|soft-chemistry|templateId/);
  });

  it("runs the 61-product merchant story through command CAS, edits, Undo, and Publish", async () => {
    const merchant = storefrontProofContext();
    const browser = await launchChromium();
    onTestFinished(() => browser.close(), 30_000);
    const browserProofPrompts = new Set([
      "Generate an effect",
      "Use the merchant shader",
      "Switch design",
      "Try another",
      "Start over",
    ]);
    const provedPrompts: string[] = [];
    let promptInFlight: string | null = null;
    const merchantAssembly = {
      context: merchant,
      references: {
        products: Object.fromEntries(merchant.products.map(({ id, handle }) => [id, { id, handle }])),
        collections: Object.fromEntries(merchant.collections.map(({ id, handle }) => [id, { id, handle }])),
        assets: {},
      },
    };
    const versions = new Map<string, LoadedStoreCommandVersion>();
    let current: StoreCommandState = { draft: null, publishedVersionId: null };
    let sequence = 0;
    const nextVersionId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
    const copyState = (): StoreCommandState => structuredClone(current);
    const conflict = () => Object.assign(new Error("stale pointer"), { code: "storefront_draft_conflict", status: 409 });

    const classify = vi.fn(async (input: Parameters<StoreCommandDependencies["classify"]>[0]) => {
      if (input.prompt === "Update the title") return { kind: "update_text" as const, slot: "heroTitle", value: "Made for long summer days" };
      if (input.prompt === "Feature the collection") return { kind: "update_merchandising" as const, productIds: merchant.products.slice(0, 12).map(({ id }) => id) };
      if (input.prompt === "Generate an effect") return {
        kind: "update_visual_layer" as const,
        visualLayer: { kind: "fragment_shader" as const, source: "void main(){gl_FragColor=vec4(u_color1,1.0);}", colors: ["#112233", "#445566", "#778899"] as [string, string, string] },
      };
      if (input.prompt === "Use the merchant shader") {
        const source = input.attachments?.find((attachment) => attachment.kind === "fragment_shader");
        if (!source || source.kind !== "fragment_shader") throw new Error("shader attachment missing");
        return { kind: "update_visual_layer" as const, visualLayer: { kind: "fragment_shader" as const, source: source.source, colors: ["#0a0a0a", "#1b1b1b", "#2c2c2c"] as [string, string, string] } };
      }
      if (input.prompt === "Unsupported structure") return { kind: "unsupported" as const, message: "Structure is protected." };
      if (input.prompt === "Start over") return { kind: "start_over" as const, prompt: input.prompt };
      return {
        kind: "select_design" as const,
        prompt: input.prompt,
        excludedTemplateIds: [...new Set([...(input.excludedTemplateIds ?? []), ...(input.currentTemplateId ? [input.currentTemplateId] : [])])],
      };
    });
    const resolveDesign = vi.fn((request: Parameters<StoreCommandDependencies["resolveDesign"]>[0]) => {
      const selected = STOREFRONT_RECIPES.find(({ config }) => !(request.excludedTemplateIds ?? []).includes(config.templateId));
      if (!selected) return {
        kind: "no_match" as const,
        reason: "all_designs_excluded" as const,
        routingVersion: 1,
        registryVersion: 1,
        catalogFingerprint: "sha256:catalog",
        breakdown: [],
        reasons: ["none"],
      };
      return { ...resolution, templateId: selected.config.templateId, templateVersion: selected.config.templateVersion };
    });
    const deps = dependencies({
      loadState: vi.fn(async () => copyState()),
      loadContext: vi.fn().mockResolvedValue(merchantAssembly),
      classify,
      resolveDesign,
      loadRecipe: vi.fn(async (templateId: Parameters<StoreCommandDependencies["loadRecipe"]>[0], templateVersion: number) => {
        const selected = STOREFRONT_RECIPES.find(({ config }) => config.templateId === templateId && config.templateVersion === templateVersion);
        if (!selected) throw new Error("recipe missing");
        return structuredClone(selected);
      }),
      applyIntent: applyStoreIntent,
      prove: vi.fn(async (input) => {
        if (!promptInFlight || !browserProofPrompts.has(promptInFlight)) {
          return { ok: true, diagnostics: [], screenshots: ["proof"], browserMs: 1 };
        }
        const result = await proveStorefrontBundle({
          ...input,
          browser,
          routes: ["home"],
          viewports: ["mobile", "desktop"],
        });
        expect(result.diagnostics).toEqual([]);
        provedPrompts.push(promptInFlight);
        return result;
      }),
      hashArtifact: vi.fn(async ({ artifact }) => `sha256:${createHash("sha256").update(JSON.stringify(artifact)).digest("hex")}`),
      createVersion: vi.fn(async (input) => {
        const versionId = nextVersionId();
        const bundle = structuredClone((input.artifact as { bundle: typeof CUSTOM_BENCH_BUNDLE }).bundle);
        versions.set(versionId, {
          versionId,
          artifactHash: `sha256:${createHash("sha256").update(JSON.stringify(bundle)).digest("hex")}`,
          bundle,
          resolution: structuredClone(input.resolution),
        });
        return versionId;
      }),
      install: vi.fn(async (input) => {
        if ((current.draft?.versionId ?? null) !== input.expectedDraftVersionId) throw conflict();
        current = { ...current, draft: structuredClone(versions.get(input.versionId)!) };
        return input.versionId;
      }),
      edit: vi.fn(async (input) => {
        if (current.draft?.versionId !== input.expectedDraftVersionId) throw conflict();
        current = { ...current, draft: structuredClone(versions.get(input.resultVersionId)!) };
        return input.resultVersionId;
      }),
      undo: vi.fn(async (input) => {
        const draft = current.draft;
        if (!draft || draft.versionId !== input.expectedDraftVersionId) throw conflict();
        const undoneVersionId = draft.versionId;
        current = { ...current, draft: structuredClone(versions.get(input.targetVersionId)!) };
        return { status: "installed" as const, versionId: input.targetVersionId, undoneVersionId };
      }),
      publish: vi.fn(async (input) => {
        if (current.draft?.versionId !== input.expectedDraftVersionId || current.publishedVersionId !== input.expectedPublishedVersionId) throw conflict();
        current = { ...current, publishedVersionId: input.expectedDraftVersionId };
        return input.expectedDraftVersionId;
      }),
    });
    const prompt = async (
      value: string,
      command: Extract<StoreCommand, { kind: "prompt" }> = promptCommand(current.draft?.versionId ?? null, value),
    ): Promise<Extract<StoreCommandReceipt, { status: "installed" }>> => {
      promptInFlight = value;
      try {
        const receipt = await runStoreCommand({ shopId: SHOP, command }, deps);
        expect(receipt.status).toBe("installed");
        if (receipt.status !== "installed") throw new Error("expected installed receipt");
        return receipt;
      } finally {
        promptInFlight = null;
      }
    };

    const initial = await prompt("Build the store", promptCommand(null, "Build the store"));
    const initialTemplateId = current.draft!.bundle.source.kind === "recipe" ? current.draft!.bundle.source.templateId : null;
    const protectedHeroHash = current.draft!.bundle.assets.entries.find(({ key }) => key === "hero")?.contentHash;
    expect(protectedHeroHash).toEqual(expect.any(String));
    await prompt("Update the title");
    expect(current.draft!.bundle.routes.home.html).toContain("Made for long summer days");
    await prompt("Feature the collection");
    expect(current.draft!.bundle.featuredProductIds).toEqual(merchant.products.slice(0, 12).map(({ id }) => id));
    await prompt("Generate an effect");
    expect(current.draft!.bundle.visualLayer).toMatchObject({ kind: "fragment_shader", source: "void main(){gl_FragColor=vec4(u_color1,1.0);}" });
    await prompt("Use the merchant shader", {
      ...promptCommand(current.draft!.versionId, "Use the merchant shader"),
      attachments: [{ kind: "fragment_shader", source: "void main(){gl_FragColor=vec4(u_color2,1.0);}" }],
    });
    expect(current.draft!.bundle.visualLayer).toMatchObject({ kind: "fragment_shader", source: "void main(){gl_FragColor=vec4(u_color2,1.0);}" });
    expect(current.draft!.bundle.assets.entries.find(({ key }) => key === "hero")?.contentHash).toBe(protectedHeroHash);

    await prompt("Switch design");
    const switchedTemplateId = current.draft!.bundle.source.kind === "recipe" ? current.draft!.bundle.source.templateId : null;
    expect(switchedTemplateId).not.toBe(initialTemplateId);
    const beforeUnsupported = current.draft!.versionId;
    const versionsBeforeUnsupported = versions.size;
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(beforeUnsupported, "Unsupported structure") }, deps))
      .resolves.toMatchObject({ status: "unchanged" });
    expect(current.draft!.versionId).toBe(beforeUnsupported);
    expect(versions.size).toBe(versionsBeforeUnsupported);
    await prompt("Try another");
    const alternateTemplateId = current.draft!.bundle.source.kind === "recipe" ? current.draft!.bundle.source.templateId : null;
    expect(alternateTemplateId).not.toBe(initialTemplateId);
    expect(alternateTemplateId).not.toBe(switchedTemplateId);
    const beforeStartOver = current.draft!.versionId;
    const beforeStartOverHash = current.draft!.artifactHash;
    const startedOver = await prompt("Start over");
    const startedOverTemplateId = current.draft!.bundle.source.kind === "recipe" ? current.draft!.bundle.source.templateId : null;
    expect(startedOverTemplateId).not.toBe(initialTemplateId);
    expect(startedOverTemplateId).not.toBe(switchedTemplateId);
    expect(startedOverTemplateId).not.toBe(alternateTemplateId);
    expect(startedOver.versionId).not.toBe(beforeStartOver);
    const startedOverRecipe = STOREFRONT_RECIPES.find(({ config }) => config.templateId === startedOverTemplateId);
    expect(startedOverRecipe).toBeDefined();
    expect(current.draft!.bundle.assets).toEqual(startedOverRecipe!.bundle.assets);
    expect(current.draft!.bundle.routes.home.css).toBe(startedOverRecipe!.bundle.routes.home.css);
    expect(current.draft!.bundle.routes.home.html).toContain("Made for long summer days");
    expect(current.draft!.bundle.featuredProductIds).toEqual(merchant.products.slice(0, 12).map(({ id }) => id));
    expect(current.draft!.bundle.visualLayer).toMatchObject({
      kind: "fragment_shader",
      source: "void main(){gl_FragColor=vec4(u_color2,1.0);}",
    });

    const beforeStaleAttempt = current.draft!.versionId;
    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(initial.versionId, "Update the title") }, deps))
      .rejects.toMatchObject({ code: "storefront_command_conflict", status: 409 });
    expect(current.draft!.versionId).toBe(beforeStaleAttempt);
    const undone = await runStoreCommand({
      shopId: SHOP,
      command: { kind: "undo", targetVersionId: beforeStartOver, expectedDraftVersionId: startedOver.versionId },
    }, deps);
    expect(undone).toMatchObject({ status: "installed", versionId: beforeStartOver });
    expect(current.draft!.artifactHash).toBe(beforeStartOverHash);
    await expect(runStoreCommand({ shopId: SHOP, command: { kind: "publish", expectedDraftVersionId: beforeStartOver } }, deps))
      .resolves.toEqual({ status: "published", versionId: beforeStartOver });
    expect(current.publishedVersionId).toBe(beforeStartOver);
    expect(merchant.products).toHaveLength(61);
    expect(merchant.products.filter(({ images }) => images.length === 0)).toHaveLength(10);
    expect(deps.prove).toHaveBeenCalled();
    expect(vi.mocked(deps.prove).mock.calls.every(([input]) => input.context.products.length === 61)).toBe(true);
    expect(provedPrompts).toEqual([...browserProofPrompts]);
  }, 120_000);
});
