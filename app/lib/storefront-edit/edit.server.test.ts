import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import { createDefaultStructuralPatchCompiler, editStorefrontByPrompt, undoStorefrontEdit, type StorefrontEditDependencies } from "./edit.server";

const SHOP = "11111111-1111-1111-1111-111111111111";
const ACTOR = "22222222-2222-2222-2222-222222222222";
const BASE = "33333333-3333-3333-3333-333333333333";
const RESULT = "44444444-4444-4444-4444-444444444444";
const RESTORED = "55555555-5555-5555-5555-555555555555";
const baseBundle = () => compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;

function dependencies(bundle = baseBundle()) {
  const deps: StorefrontEditDependencies = {
    loadDraft: vi.fn().mockResolvedValue({ versionId: BASE, artifactHash: `sha256:${"a".repeat(64)}`, bundle }),
    loadVersion: vi.fn().mockResolvedValue({ versionId: BASE, artifactHash: `sha256:${"a".repeat(64)}`, bundle }),
    loadEditAudit: vi.fn().mockResolvedValue({ baseVersionId: BASE, resultVersionId: RESULT }),
    recipeBuildEnabled: vi.fn().mockReturnValue(true),
    customBuildEnabled: vi.fn().mockReturnValue(true),
    preflight: vi.fn().mockResolvedValue(undefined),
    compileStructuralPatch: vi.fn(),
    validate: vi.fn().mockReturnValue({ profileVersion: 1, ok: true, diagnostics: [] }),
    loadProofContext: vi.fn().mockResolvedValue({ fingerprint: "proof-context" } as never),
    loadProofAssets: vi.fn().mockResolvedValue([]),
    prove: vi.fn().mockResolvedValue({ ok: true, diagnostics: [], screenshots: ["proof:home"], browserMs: 25 }),
    createVersion: vi.fn().mockResolvedValue(RESULT),
    cloneAssetProvenance: vi.fn().mockResolvedValue(undefined),
    validateVersion: vi.fn().mockResolvedValue(RESULT),
    hashArtifact: vi.fn().mockResolvedValue(`sha256:${"b".repeat(64)}`),
    editDraft: vi.fn().mockResolvedValue(RESULT),
    randomId: vi.fn().mockReturnValue("edit-generation"),
  };
  return deps;
}

beforeEach(() => vi.restoreAllMocks());

describe("editStorefrontByPrompt", () => {
  it("blocks recipe edits at the recipe writer switch before proof or persistence", async () => {
    const recipe = baseBundle();
    recipe.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    const deps = dependencies(recipe);
    vi.mocked(deps.recipeBuildEnabled).mockReturnValue(false);

    await expect(editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Make the accent #ff5500", expectedDraftVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_recipe_build_disabled", status: 503 });

    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.compileStructuralPatch).not.toHaveBeenCalled();
    expect(deps.loadProofContext).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("blocks custom structural edits before quota, provider, proof, or persistence", async () => {
    const deps = dependencies();
    vi.mocked(deps.customBuildEnabled).mockReturnValue(false);

    await expect(editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Create a new editorial hero", expectedDraftVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_custom_build_disabled", status: 503 });

    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.compileStructuralPatch).not.toHaveBeenCalled();
    expect(deps.loadProofContext).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("persists an override-safe recipe edit without detaching and writes replayable audit", async () => {
    const recipe = baseBundle();
    recipe.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    const deps = dependencies(recipe);
    const result = await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Make the accent #ff5500", expectedDraftVersionId: BASE,
    }, deps);
    if (result.status !== "installed") throw new Error("expected installed edit");
    expect(result.detachedFromRecipe).toBe(false);
    expect(result.changedScope).toEqual({ designTokens: ["ink"], routes: [] });
    expect(deps.compileStructuralPatch).not.toHaveBeenCalled();
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "recipe", templateId: "atelier-nine", templateVersion: 1,
    }));
    expect(deps.editDraft).toHaveBeenCalledWith(expect.objectContaining({
      baseVersionId: BASE,
      resultVersionId: RESULT,
      expectedDraftVersionId: BASE,
      prompt: "Make the accent #ff5500",
      patch: expect.objectContaining({ operations: [expect.objectContaining({ kind: "setToken" })] }),
      provider: expect.objectContaining({ kind: "deterministic", model: null }),
      validation: expect.objectContaining({ browserProof: expect.objectContaining({ ok: true, browserMs: 25 }) }),
    }));
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
    const audit = vi.mocked(deps.editDraft).mock.calls[0]![0];
    expect(audit.scope).toMatchObject({
      selectedScope: null,
      compiler: { schemaVersion: 1, runtimeVersion: 1, validationProfileVersion: 1 },
    });
    expect(audit.provider).toMatchObject({
      attempts: [expect.objectContaining({ attempt: 1, kind: "deterministic" })],
      totalUsage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(audit.validation).toMatchObject({
      proofContextFingerprint: "proof-context",
      catalogFingerprint: "proof-context",
      attempts: [expect.objectContaining({ attempt: 1, staticDiagnostics: [], browserDiagnostics: [] })],
    });
  });

  it("detaches recipe text, visibility, and layout edits outside the declared semantic override surface", async () => {
    const recipe = baseBundle();
    recipe.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    const root = recipe.routes.home.tree[0]!;
    if (root.kind !== "element") throw new Error("fixture root");
    const arbitrary = root;
    const deps = dependencies(recipe);

    const result = await editStorefrontByPrompt({
      shopId: SHOP,
      prompt: `Set headline to "A deliberately different line"`,
      expectedDraftVersionId: BASE,
      context: { routeId: "home", regionId: arbitrary.id },
    }, deps);

    if (result.status !== "installed") throw new Error("expected installed edit");
    expect(result.detachedFromRecipe).toBe(true);
    expect(result.bundle.source).toMatchObject({ kind: "custom", derivedFromTemplateId: "atelier-nine" });
  });

  it("detaches a structural recipe edit, preserves untouched routes, and never regenerates the store", async () => {
    const recipe = baseBundle();
    recipe.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    const productBefore = structuredClone(recipe.routes.product);
    recipe.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    const deps = dependencies(recipe);
    const homeTarget = recipe.routes.home.tree[0];
    if (homeTarget.kind !== "element") throw new Error("fixture");
    vi.mocked(deps.compileStructuralPatch).mockResolvedValue({
      operations: [{
        kind: "replaceTextChildren", routeId: "home", targetId: homeTarget.id, value: "A new editorial opening",
        expected: `sha256:${createHash("sha256").update(JSON.stringify(homeTarget)).digest("hex")}`,
      }],
      provider: { kind: "ai_patch", provider: "anthropic", model: "test", usage: { inputTokens: 5, outputTokens: 7 } },
    });
    const result = await editStorefrontByPrompt({
      shopId: SHOP,
      actorId: ACTOR,
      prompt: "Turn the home opening into an editorial composition",
      expectedDraftVersionId: BASE,
      context: { routeId: "home", regionId: homeTarget.id },
    }, deps);
    if (result.status !== "installed") throw new Error("expected installed edit");
    expect(result.detachedFromRecipe).toBe(true);
    expect(result.bundle.source).toMatchObject({
      kind: "custom", derivedFromVersionId: BASE, derivedFromTemplateId: "atelier-nine", derivedFromTemplateVersion: 1,
    });
    expect(result.bundle.routes.product).toEqual(productBefore);
    expect(deps.compileStructuralPatch).toHaveBeenCalledTimes(1);
    expect(deps.preflight).toHaveBeenCalledWith({ shopId: SHOP, prompt: "Turn the home opening into an editorial composition", trusted: false });
    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "custom",
      status: "candidate",
      validationReport: null,
    }));
    expect(deps.cloneAssetProvenance).toHaveBeenCalledWith({ shopId: SHOP, sourceVersionId: BASE, targetVersionId: RESULT });
    expect(deps.validateVersion).toHaveBeenCalledWith(expect.objectContaining({
      shopId: SHOP,
      versionId: RESULT,
      validationReport: expect.objectContaining({ valid: true }),
    }));
    expect(vi.mocked(deps.cloneAssetProvenance).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.validateVersion).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(deps.validateVersion).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.editDraft).mock.invocationCallOrder[0]!,
    );
  });

  it("targets the repeat owner when a selected product-card region cannot be structurally replaced", async () => {
    const bundle = baseBundle();
    const repeatRoot = bundle.routes.collection.tree[0];
    if (repeatRoot.kind !== "element" || !repeatRoot.repeat || repeatRoot.children[0]?.kind !== "element") {
      throw new Error("fixture repeat");
    }
    const repeatedChild = repeatRoot.children[0];
    const deps = dependencies(bundle);
    vi.mocked(deps.compileStructuralPatch).mockResolvedValue({
      operations: [{
        kind: "replaceTextChildren",
        routeId: "collection",
        targetId: repeatRoot.id,
        value: "A redesigned product grid",
        expected: `sha256:${createHash("sha256").update(JSON.stringify(repeatRoot)).digest("hex")}`,
      }],
      provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
    });
    const stages: string[] = [];

    await editStorefrontByPrompt({
      shopId: SHOP,
      actorId: ACTOR,
      prompt: "Redesign this product card layout",
      expectedDraftVersionId: BASE,
      context: { routeId: "collection", regionId: repeatedChild.id },
      onEvent: (event) => stages.push(event.stage),
    }, deps);

    expect(deps.compileStructuralPatch).toHaveBeenCalledWith(expect.objectContaining({
      context: { routeId: "collection", regionId: repeatRoot.id },
    }));
    expect(stages).toEqual(["compiling", "validating", "proofing", "installing", "installed"]);
    expect(deps.editDraft).toHaveBeenCalledTimes(1);
  });

  it("recompiles an unscoped repeated-child replacement against its repeat owner", async () => {
    const bundle = baseBundle();
    const repeatRoot = bundle.routes.collection.tree[0];
    if (repeatRoot.kind !== "element" || !repeatRoot.repeat || repeatRoot.children[0]?.kind !== "element") {
      throw new Error("fixture repeat");
    }
    const repeatedChild = repeatRoot.children[0];
    const deps = dependencies(bundle);
    vi.mocked(deps.compileStructuralPatch)
      .mockResolvedValueOnce({
        operations: [{
          kind: "replaceRegion",
          routeId: "collection",
          targetId: repeatedChild.id,
          expected: `sha256:${createHash("sha256").update(JSON.stringify(repeatedChild)).digest("hex")}`,
          source: { html: "<article>New card</article>", css: "" },
        }],
        provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
      })
      .mockResolvedValueOnce({
        operations: [{
          kind: "replaceTextChildren",
          routeId: "collection",
          targetId: repeatRoot.id,
          value: "A redesigned product grid",
          expected: `sha256:${createHash("sha256").update(JSON.stringify(repeatRoot)).digest("hex")}`,
        }],
        provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
      });

    await editStorefrontByPrompt({
      shopId: SHOP,
      actorId: ACTOR,
      prompt: "Redesign the product cards",
      expectedDraftVersionId: BASE,
    }, deps);

    expect(deps.compileStructuralPatch).toHaveBeenCalledTimes(2);
    expect(deps.compileStructuralPatch).toHaveBeenLastCalledWith(expect.objectContaining({
      context: { routeId: "collection", regionId: repeatRoot.id },
      repair: expect.objectContaining({ scope: { routeId: "collection", regionId: repeatRoot.id } }),
    }));
    expect(deps.editDraft).toHaveBeenCalledTimes(1);
  });

  it("clones verified logical asset references before validating an edited custom version", async () => {
    const custom = baseBundle();
    custom.assets.entries = [{ key: "hero", contentHash: "b".repeat(64), mediaType: "image/webp", byteSize: 84 }];
    const deps = dependencies(custom);
    const verifiedBytes = [{
      key: "hero", logicalKey: "hero", contentHash: "b".repeat(64), mediaType: "image/webp", byteSize: 84,
      bytes: new Uint8Array(84).fill(1),
    }];
    vi.mocked(deps.loadProofAssets).mockResolvedValue(verifiedBytes);

    await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Make the accent #ff5500", expectedDraftVersionId: BASE,
    }, deps);

    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "custom", status: "candidate" }));
    expect(deps.loadProofAssets).toHaveBeenCalledWith({ shopId: SHOP, versionId: BASE, manifest: custom.assets });
    expect(deps.prove).toHaveBeenCalledWith(expect.objectContaining({ persistedAssets: verifiedBytes }));
    expect(vi.mocked(deps.loadProofAssets).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
    expect(deps.cloneAssetProvenance).toHaveBeenCalledWith({ shopId: SHOP, sourceVersionId: BASE, targetVersionId: RESULT });
    expect(deps.validateVersion).toHaveBeenCalledWith(expect.objectContaining({ versionId: RESULT }));
  });

  it("returns no-change on validation failure and never writes a version or audit", async () => {
    const deps = dependencies();
    vi.mocked(deps.validate).mockReturnValue({
      profileVersion: 1, ok: false, diagnostics: [{ code: "bad", path: "routes.home", message: "bad" }],
    });
    await expect(editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Make the accent #ff5500", expectedDraftVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_edit_invalid" });
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("fails closed when mandatory production browser proof fails before any immutable version is created", async () => {
    const deps = dependencies();
    vi.mocked(deps.prove).mockRejectedValue(Object.assign(new Error("Browser proof failed"), {
      report: { ok: false, diagnostics: [{ routeId: "home", code: "overflow", message: "horizontal overflow" }], screenshots: [], browserMs: 31 },
    }));
    await expect(editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Make the accent #ff5500", expectedDraftVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_edit_browser_proof_failed", status: 422 });
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.validateVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("repairs one scoped structural candidate after failed browser proof without persisting the failed candidate", async () => {
    const recipe = baseBundle();
    recipe.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    const target = recipe.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");
    const deps = dependencies(recipe);
    vi.mocked(deps.compileStructuralPatch)
      .mockResolvedValueOnce({
        operations: [{ kind: "replaceTextChildren", routeId: "home", targetId: target.id, value: "Overflowing opening", expected: `sha256:${createHash("sha256").update(JSON.stringify(target)).digest("hex")}` }],
        provider: { kind: "ai_patch", provider: "fixture", model: "fixture-model" },
      })
      .mockResolvedValueOnce({
        operations: [{ kind: "replaceTextChildren", routeId: "home", targetId: target.id, value: "Repaired opening", expected: `sha256:${createHash("sha256").update(JSON.stringify(target)).digest("hex")}` }],
        provider: { kind: "ai_patch", provider: "fixture", model: "fixture-model" },
      });
    vi.mocked(deps.prove)
      .mockRejectedValueOnce(Object.assign(new Error("Browser proof failed"), {
        report: { ok: false, diagnostics: [{ routeId: "home", regionId: target.id, code: "overflow", message: "horizontal overflow" }], screenshots: [], browserMs: 20 },
      }))
      .mockResolvedValueOnce({ ok: true, diagnostics: [], screenshots: ["proof:repaired"], browserMs: 22 });

    const result = await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Recompose this opening", expectedDraftVersionId: BASE,
      context: { routeId: "home", regionId: target.id },
    }, deps);

    expect(result.status).toBe("installed");
    expect(deps.compileStructuralPatch).toHaveBeenCalledTimes(2);
    expect(deps.compileStructuralPatch).toHaveBeenLastCalledWith(expect.objectContaining({
      repair: expect.objectContaining({ browserProof: expect.objectContaining({ ok: false }) }),
    }));
    expect(deps.prove).toHaveBeenCalledTimes(2);
    expect(deps.createVersion).toHaveBeenCalledTimes(1);
    expect(deps.editDraft).toHaveBeenCalledTimes(1);
    expect(deps.compileStructuralPatch).toHaveBeenLastCalledWith(expect.objectContaining({
      repair: expect.objectContaining({ scope: { routeId: "home", regionId: target.id } }),
    }));
    const audit = vi.mocked(deps.editDraft).mock.calls[0]![0];
    expect(audit.provider).toMatchObject({ attempts: [expect.any(Object), expect.any(Object)] });
    expect(audit.validation).toMatchObject({
      attempts: [
        expect.objectContaining({ browserDiagnostics: [expect.objectContaining({ routeId: "home", regionId: target.id })] }),
        expect.objectContaining({ browserDiagnostics: [] }),
      ],
    });
  });

  it("requires browser proof even for deterministic layout-affecting edits", async () => {
    const bundle = baseBundle();
    const root = bundle.routes.home.tree[0]!;
    if (root.kind !== "element") throw new Error("fixture root");
    const second = structuredClone(root);
    second.id = "home-second";
    root.children.push(second);
    const deps = dependencies(bundle);
    await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Move this section down", expectedDraftVersionId: BASE,
      context: { routeId: "home", regionId: root.children[0]!.kind === "element" ? root.children[0]!.id : root.id },
    }, deps);
    expect(deps.prove).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
  });

  it("rejects a stale base before provider spend or writes", async () => {
    const deps = dependencies();
    await expect(editStorefrontByPrompt({
      shopId: SHOP,
      actorId: ACTOR,
      prompt: "Create a new editorial hero",
      expectedDraftVersionId: "55555555-5555-5555-5555-555555555555",
    }, deps)).rejects.toMatchObject({ code: "storefront_edit_conflict", status: 409 });
    expect(deps.compileStructuralPatch).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
  });

  it("does not mint a version when a deterministic patch is a no-op", async () => {
    const deps = dependencies();
    await expect(editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Use Fraunces for headings", expectedDraftVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_edit_no_change" });
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("keeps catalog and customer data out of the replayable edit audit", async () => {
    const deps = dependencies();
    await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Make the accent #ff5500", expectedDraftVersionId: BASE,
    }, deps);
    const audit = vi.mocked(deps.editDraft).mock.calls[0]![0];
    const serialized = JSON.stringify({ scope: audit.scope, patch: audit.patch, provider: audit.provider, validation: audit.validation });
    expect(serialized).not.toContain("products");
    expect(serialized).not.toContain("customers");
    expect(serialized).not.toContain("shopId");
  });

  it("reports explicit start-over without editing so the caller can re-enter routing", async () => {
    const deps = dependencies();
    const result = await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Start over with a completely new store", expectedDraftVersionId: BASE,
    }, deps);
    expect(result).toEqual({ status: "start_over", mode: "custom" });
    expect(deps.loadDraft).not.toHaveBeenCalled();
  });
});

describe("createDefaultStructuralPatchCompiler", () => {
  it("accepts only strict compiler-source structural operations and carries preview scope preconditions", async () => {
    const bundle = baseBundle();
    bundle.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");
    const provider = {
      complete: vi.fn().mockResolvedValue({
        value: { operations: [{
          kind: "replaceRegion", routeId: "home", targetId: target.id,
          expected: "sha256:" + "a".repeat(64),
          source: { html: `<main id="new-hero"><img data-cd-asset="hero" alt="Hero"></main>`, css: `.new-hero { display:grid }` },
        }] },
        provider: "fixture", model: "fixture-model", usage: { inputTokens: 1, outputTokens: 2 },
      }),
    };
    const compile = createDefaultStructuralPatchCompiler(provider);
    const result = await compile({
      prompt: "Create a cinematic image-led composition",
      context: { routeId: "home", regionId: target.id },
      bundle,
    });
    expect(result.operations[0]).toMatchObject({ kind: "replaceRegion", routeId: "home", targetId: target.id });
    expect(provider.complete).toHaveBeenCalledWith(expect.objectContaining({
      operation: "patch",
      schema: expect.objectContaining({ type: "object" }),
    }));
    const serializedPrompt = vi.mocked(provider.complete).mock.calls[0]![0].prompt;
    expect(serializedPrompt).toContain("Verified owned asset keys: hero");
    expect(serializedPrompt).not.toContain("contentHash");
  });

  it("rejects model operations that escape the selected route or region", async () => {
    const bundle = baseBundle();
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");
    const provider = { complete: vi.fn().mockResolvedValue({
      value: { operations: [{ kind: "replaceRouteCss", routeId: "product", expected: "sha256:" + "a".repeat(64), css: ".x{display:block}" }] },
      provider: "fixture", model: "fixture-model",
    }) };
    await expect(createDefaultStructuralPatchCompiler(provider)({
      prompt: "Change this", context: { routeId: "home", regionId: target.id }, bundle,
    })).rejects.toMatchObject({ code: "storefront_patch_scope" });
  });

  it("rejects route-wide CSS for a selected region and generic patches spanning routes", async () => {
    const bundle = baseBundle();
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");
    const scopedProvider = { complete: vi.fn().mockResolvedValue({
      value: { operations: [{ kind: "replaceRouteCss", routeId: "home", expected: `sha256:${"a".repeat(64)}`, css: ".x{display:block}" }] },
      provider: "fixture", model: "fixture-model", usage: { inputTokens: 1, outputTokens: 1 },
    }) };
    await expect(createDefaultStructuralPatchCompiler(scopedProvider)({
      prompt: "Change this", context: { routeId: "home", regionId: target.id }, bundle,
    })).rejects.toMatchObject({ code: "storefront_patch_scope" });

    const genericProvider = { complete: vi.fn().mockResolvedValue({
      value: { operations: [
        { kind: "replaceRegion", routeId: "home", targetId: target.id, expected: `sha256:${"a".repeat(64)}`, source: { html: "<main>One</main>", css: "" } },
        { kind: "replaceRegion", routeId: "product", targetId: bundle.routes.product.tree[0]!.kind === "element" ? bundle.routes.product.tree[0]!.id : "bad", expected: `sha256:${"b".repeat(64)}`, source: { html: "<main>Two</main>", css: "" } },
      ] },
      provider: "fixture", model: "fixture-model", usage: { inputTokens: 1, outputTokens: 1 },
    }) };
    await expect(createDefaultStructuralPatchCompiler(genericProvider)({ prompt: "Change the composition", bundle }))
      .rejects.toMatchObject({ code: "storefront_patch_scope" });
  });

  it("requires exact subtree hashes on model-authored text and visibility operations", async () => {
    const bundle = baseBundle();
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");
    const provider = { complete: vi.fn().mockResolvedValue({
      value: { operations: [{ kind: "setVisibility", routeId: "home", targetId: target.id, hidden: true }] },
      provider: "fixture", model: "fixture-model", usage: { inputTokens: 1, outputTokens: 1 },
    }) };
    await expect(createDefaultStructuralPatchCompiler(provider)({ prompt: "Hide it", bundle }))
      .rejects.toMatchObject({ code: "storefront_patch_invalid" });
  });

  it("binds a repair compiler call to the diagnosed route and region", async () => {
    const bundle = baseBundle();
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");
    const provider = { complete: vi.fn().mockResolvedValue({
      value: { operations: [{
        kind: "replaceRegion", routeId: "product",
        targetId: bundle.routes.product.tree[0]!.kind === "element" ? bundle.routes.product.tree[0]!.id : "bad",
        expected: `sha256:${"a".repeat(64)}`, source: { html: "<main>Escape</main>", css: "" },
      }] },
      provider: "fixture", model: "fixture-model", usage: { inputTokens: 1, outputTokens: 1 },
    }) };
    await expect(createDefaultStructuralPatchCompiler(provider)({
      prompt: "Repair it",
      bundle,
      repair: {
        attempt: 1,
        scope: { routeId: "home", regionId: target.id },
        browserProof: { ok: false, diagnostics: [{ routeId: "home", regionId: target.id, code: "overflow", message: "overflow" }], screenshots: [], browserMs: 1 },
      },
    })).rejects.toMatchObject({ code: "storefront_patch_scope" });
  });
});

describe("undoStorefrontEdit", () => {
  it("blocks a custom restore at the custom writer switch before proof or persistence", async () => {
    const deps = dependencies();
    vi.mocked(deps.customBuildEnabled).mockReturnValue(false);
    vi.mocked(deps.loadDraft).mockResolvedValue({
      versionId: RESULT,
      artifactHash: `sha256:${"b".repeat(64)}`,
      bundle: baseBundle(),
    });

    await expect(undoStorefrontEdit({
      shopId: SHOP, actorId: ACTOR, expectedDraftVersionId: RESULT, targetVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_custom_build_disabled", status: 503 });

    expect(deps.loadProofContext).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("creates a fresh immutable restore version with cloned provenance before the atomic undo CAS", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadDraft).mockResolvedValue({ versionId: RESULT, artifactHash: `sha256:${"b".repeat(64)}`, bundle: baseBundle() });
    vi.mocked(deps.createVersion).mockResolvedValue(RESTORED);
    vi.mocked(deps.validateVersion).mockResolvedValue(RESTORED);
    const verifiedBytes = [{
      key: "hero", logicalKey: "hero", contentHash: "c".repeat(64), mediaType: "image/webp", byteSize: 3,
      bytes: new Uint8Array([1, 2, 3]),
    }];
    const target = baseBundle();
    target.assets.entries = [{ key: "hero", contentHash: "c".repeat(64), mediaType: "image/webp", byteSize: 3 }];
    vi.mocked(deps.loadVersion).mockResolvedValue({ versionId: BASE, artifactHash: `sha256:${"a".repeat(64)}`, bundle: target });
    vi.mocked(deps.loadProofAssets).mockResolvedValue(verifiedBytes);
    const result = await undoStorefrontEdit({
      shopId: SHOP, actorId: ACTOR, expectedDraftVersionId: RESULT, targetVersionId: BASE,
    }, deps);
    expect(result).toEqual({ status: "installed", versionId: RESTORED, undoneVersionId: RESULT });
    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "custom",
      status: "candidate",
      resolution: { kind: "undo", restoredFromVersionId: BASE, undoneVersionId: RESULT },
    }));
    expect(deps.cloneAssetProvenance).toHaveBeenCalledWith({ shopId: SHOP, sourceVersionId: BASE, targetVersionId: RESTORED });
    expect(deps.loadProofAssets).toHaveBeenCalledWith({ shopId: SHOP, versionId: BASE, manifest: target.assets });
    expect(deps.prove).toHaveBeenCalledWith(expect.objectContaining({ persistedAssets: verifiedBytes }));
    expect(vi.mocked(deps.prove).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.createVersion).mock.invocationCallOrder[0]!);
    expect(deps.validateVersion).toHaveBeenCalledWith(expect.objectContaining({ versionId: RESTORED }));
    expect(deps.editDraft).toHaveBeenCalledWith(expect.objectContaining({
      baseVersionId: RESULT,
      resultVersionId: RESTORED,
      expectedDraftVersionId: RESULT,
      prompt: "Undo storefront edit",
      patch: { operations: [{ kind: "restoreVersion", versionId: BASE }] },
    }));
    expect(deps.loadEditAudit).toHaveBeenCalledWith({ shopId: SHOP, resultVersionId: RESULT });
    expect(vi.mocked(deps.loadEditAudit).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(deps.prove).mock.invocationCallOrder[0]!);
  });

  it("rejects an undo target that is not the current edit audit base before proof or writes", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadDraft).mockResolvedValue({ versionId: RESULT, artifactHash: `sha256:${"b".repeat(64)}`, bundle: baseBundle() });
    vi.mocked(deps.loadEditAudit).mockResolvedValue({
      baseVersionId: "66666666-6666-6666-6666-666666666666",
      resultVersionId: RESULT,
    });

    await expect(undoStorefrontEdit({
      shopId: SHOP, actorId: ACTOR, expectedDraftVersionId: RESULT, targetVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_undo_target_invalid", status: 409 });
    expect(deps.loadVersion).not.toHaveBeenCalled();
    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });
});
