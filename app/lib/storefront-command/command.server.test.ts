import { describe, expect, it, vi } from "vitest";
import { CUSTOM_BENCH_BUNDLE } from "../storefront-recipes/custom-bench/bundle";
import type { StoreCommand, StoreCommandEvent } from "./types";
import {
  runStoreCommand,
  type StoreCommandDependencies,
} from "./command.server";

const SHOP = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const CURRENT = "33333333-3333-3333-3333-333333333333";
const RESULT = "44444444-4444-4444-4444-444444444444";
const TARGET = "55555555-5555-5555-5555-555555555555";
const HASH = `sha256:${"a".repeat(64)}`;
const RESULT_HASH = `sha256:${"b".repeat(64)}`;

const promptCommand = (expectedDraftVersionId: string | null, prompt = "Make it calm"): StoreCommand => ({
  kind: "prompt",
  prompt,
  expectedDraftVersionId,
});

const resolution = {
  kind: "recipe" as const,
  templateId: "custom-bench" as const,
  templateVersion: 1,
  selectionKind: "niche_match" as const,
  routingVersion: 1,
  registryVersion: 1,
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

function state(excludedTemplateIds = ["soft-chemistry" as const]) {
  return {
    draft: {
      versionId: CURRENT,
      artifactHash: HASH,
      bundle: structuredClone(CUSTOM_BENCH_BUNDLE),
      resolution: { excludedTemplateIds },
    },
    publishedVersionId: TARGET,
  };
}

function dependencies(overrides: Partial<StoreCommandDependencies> = {}): StoreCommandDependencies {
  return {
    loadState: vi.fn().mockResolvedValue({ draft: null, publishedVersionId: null }),
    assertWriteAllowed: vi.fn().mockResolvedValue(undefined),
    assertPublishable: vi.fn().mockResolvedValue(undefined),
    recipeBuildEnabled: () => true,
    publishEnabled: () => true,
    buildEvidence: vi.fn().mockResolvedValue({
      productTitles: [], productTypes: [], productTags: [], optionNames: [], collectionTitles: [], fingerprint: "sha256:catalog",
    }),
    loadContext: vi.fn().mockResolvedValue(context),
    classify: vi.fn().mockResolvedValue({ kind: "unsupported", message: "No safe change." }),
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

    expect(deps.resolveDesign).toHaveBeenCalledWith(expect.objectContaining({ excludedTemplateIds: [] }), expect.anything());
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.install).mock.invocationCallOrder[0]!);
    expect(deps.install).toHaveBeenCalledWith({
      shopId: SHOP, versionId: RESULT, expectedDraftVersionId: null, actorId: USER,
    });
    const provedBundle = vi.mocked(deps.prove).mock.calls[0]![0].bundle;
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

  it("rejects a stale expected draft before classification or proof spend", async () => {
    const deps = dependencies({ loadState: vi.fn().mockResolvedValue(state()) });

    await expect(runStoreCommand({ shopId: SHOP, command: promptCommand(TARGET) }, deps))
      .rejects.toMatchObject({ code: "storefront_command_conflict", status: 409 });

    expect(deps.classify).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
  });

  it("loads persisted exclusions and audited-CAS switches an existing design", async () => {
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

  it("keeps design references unchanged when they cannot be resolved deterministically", async () => {
    const deps = dependencies();
    const command = {
      ...promptCommand(null),
      attachments: [{ kind: "design_reference" as const, assetRef: "opaque-asset" }],
    };

    await expect(runStoreCommand({ shopId: SHOP, command }, deps)).resolves.toMatchObject({ status: "unchanged" });
    expect(deps.resolveDesign).not.toHaveBeenCalled();
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

  it("maps unknown upstream failures to one fixed merchant-safe stream error", async () => {
    const events: StoreCommandEvent[] = [];
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

  it("rejects a recipe whose immutable source does not match the selected resolution", async () => {
    const mismatched = structuredClone(CUSTOM_BENCH_BUNDLE);
    if (mismatched.source.kind !== "recipe") throw new Error("recipe fixture required");
    mismatched.source.templateId = "soft-chemistry";
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
});
