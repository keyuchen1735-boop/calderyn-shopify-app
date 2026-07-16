import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import { renderStorefrontSurface, type PublicPresentationData } from "../storefront-runtime/render.server";
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

  it("restores a known compiled text binding before applying replacement source", async () => {
    const bundle = baseBundle();
    const homeRoot = bundle.routes.home.tree[0];
    const binding = bundle.routes.home.bindings[0];
    if (homeRoot.kind !== "element" || !binding || binding.ref.kind !== "data") throw new Error("fixture binding");
    const deps = dependencies(bundle);
    vi.mocked(deps.compileStructuralPatch).mockResolvedValue({
      operations: [{
        kind: "replaceRegion",
        routeId: "home",
        targetId: homeRoot.id,
        expected: `sha256:${createHash("sha256").update(JSON.stringify(homeRoot)).digest("hex")}`,
        source: { html: `<main><h1 data-cd-bind-text="${binding.id}"></h1><p>New composition</p></main>`, css: "" },
      }],
      provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
    });

    const result = await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Redesign the home hero", expectedDraftVersionId: BASE,
    }, deps);
    if (result.status !== "installed") throw new Error("expected installed edit");

    expect(result.bundle.routes.home.bindings).toEqual([
      expect.objectContaining({ kind: "text", ref: binding.ref }),
    ]);
    const data: PublicPresentationData = {
      store: { name: "Merchant Store", logo: null }, policyLinks: [], product: null, collection: null,
      featuredProducts: [], relatedProducts: [], search: null, cart: null, notFound: null,
    };
    const preview = renderToStaticMarkup(renderStorefrontSurface({
      bundle: result.bundle, routeId: "home", data, nonce: "preview", mode: "preview",
    }));
    expect(preview).toContain("Merchant Store");
    expect(deps.compileStructuralPatch).toHaveBeenCalledTimes(1);
    expect(deps.prove).toHaveBeenCalledTimes(1);
    expect(deps.editDraft).toHaveBeenCalledTimes(1);
  });

  it("repairs compiled-only repeat metadata returned as replacement source", async () => {
    const bundle = baseBundle();
    const repeatRoot = bundle.routes.collection.tree[0];
    if (repeatRoot.kind !== "element" || !repeatRoot.repeat || repeatRoot.children[0]?.kind !== "element") {
      throw new Error("fixture repeat");
    }
    const repeatedChild = repeatRoot.children[0];
    const deps = dependencies(bundle);
    const hash = (node: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(node)).digest("hex")}`;
    vi.mocked(deps.compileStructuralPatch)
      .mockResolvedValueOnce({
        operations: [{
          kind: "replaceRegion", routeId: "collection", targetId: repeatedChild.id, expected: hash(repeatedChild),
          source: { html: "<article>New card</article>", css: "" },
        }],
        provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
      })
      .mockResolvedValueOnce({
        operations: [{
          kind: "replaceRegion", routeId: "collection", targetId: repeatRoot.id, expected: hash(repeatRoot),
          source: { html: `<main data-cd-repeat-id="${repeatRoot.repeat.scopeId}"><article>New card</article></main>`, css: "" },
        }],
        provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
      })
      .mockResolvedValueOnce({
        operations: [{
          kind: "replaceTextChildren", routeId: "collection", targetId: repeatRoot.id,
          value: "A redesigned product grid", expected: hash(repeatRoot),
        }],
        provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
      });

    await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Redesign the product cards", expectedDraftVersionId: BASE,
    }, deps);

    expect(deps.compileStructuralPatch).toHaveBeenCalledTimes(3);
    expect(deps.compileStructuralPatch).toHaveBeenLastCalledWith(expect.objectContaining({
      context: { routeId: "collection", regionId: repeatRoot.id },
      repair: expect.objectContaining({
        staticDiagnostics: [expect.objectContaining({ code: "patch_source_invalid", message: expect.stringContaining("data-cd-repeat-id") })],
      }),
    }));
    expect(deps.editDraft).toHaveBeenCalledTimes(1);
  });

  it("repairs the failing route without dropping other routes", async () => {
    const bundle = baseBundle();
    const home = bundle.routes.home.tree[0]!;
    const product = bundle.routes.product.tree[0]!;
    if (home.kind !== "element" || product.kind !== "element") throw new Error("fixture root");
    const hash = (node: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(node)).digest("hex")}`;
    const deps = dependencies(bundle);
    vi.mocked(deps.compileStructuralPatch)
      .mockResolvedValueOnce({
        operations: [
          { kind: "replaceRegion", routeId: "home", targetId: home.id, expected: hash(home), source: { html: "<main>New home</main>", css: "" } },
          { kind: "replaceRegion", routeId: "product", targetId: product.id, expected: hash(product), source: { html: '<main data-cd-trusted-slot-id="bad">Broken</main>', css: "" } },
        ],
        provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
      })
      .mockResolvedValueOnce({
        operations: [{ kind: "replaceRegion", routeId: "product", targetId: product.id, expected: hash(product), source: { html: "<main>New product</main>", css: "" } }],
        provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
      });

    const result = await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Revamp store", expectedDraftVersionId: BASE,
    }, deps);
    if (result.status !== "installed") throw new Error("expected installed edit");

    expect(deps.compileStructuralPatch).toHaveBeenLastCalledWith(expect.objectContaining({
      context: { routeId: "product", regionId: product.id },
    }));
    expect(result.changedScope.routes).toEqual(["home", "product"]);
    expect(result.bundle.routes.home.html).toContain("New home");
    expect(result.bundle.routes.product.html).toContain("New product");
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

  it("applies and proves one coherent store-wide patch across multiple routes", async () => {
    const recipe = baseBundle();
    recipe.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    const home = recipe.routes.home.tree[0]!;
    const product = recipe.routes.product.tree[0]!;
    if (home.kind !== "element" || product.kind !== "element") throw new Error("fixture roots");
    const deps = dependencies(recipe);
    vi.mocked(deps.compileStructuralPatch).mockResolvedValue({
      operations: [
        {
          kind: "replaceTextChildren", routeId: "home", targetId: home.id, value: "A cohesive home direction",
          expected: `sha256:${createHash("sha256").update(JSON.stringify(home)).digest("hex")}`,
        },
        {
          kind: "replaceTextChildren", routeId: "product", targetId: product.id, value: "A cohesive product direction",
          expected: `sha256:${createHash("sha256").update(JSON.stringify(product)).digest("hex")}`,
        },
      ],
      provider: { kind: "ai_patch", provider: "anthropic", model: "test" },
    });

    const result = await editStorefrontByPrompt({
      shopId: SHOP,
      actorId: ACTOR,
      prompt: "Take the entire storefront in a cohesive editorial direction",
      expectedDraftVersionId: BASE,
    }, deps);

    if (result.status !== "installed") throw new Error("expected installed edit");
    expect(result.changedScope.routes).toEqual(["home", "product"]);
    expect(deps.prove).toHaveBeenCalledTimes(1);
    expect(deps.editDraft).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ routes: ["home", "product"] }),
    }));
  });

  it("never swaps the draft when cancellation arrives after immutable version creation", async () => {
    const controller = new AbortController();
    const deps = dependencies();
    vi.mocked(deps.createVersion).mockImplementation(async () => {
      controller.abort();
      return "55555555-5555-5555-5555-555555555555";
    });

    await expect(editStorefrontByPrompt({
      shopId: SHOP,
      actorId: ACTOR,
      prompt: "Make the accent #ff5500",
      expectedDraftVersionId: BASE,
      signal: controller.signal,
    }, deps)).rejects.toMatchObject({ code: "storefront_edit_cancelled", status: 409 });
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("reports explicit start-over without editing so the caller can re-enter routing", async () => {
    const deps = dependencies();
    const result = await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Start over with a completely new store", expectedDraftVersionId: BASE,
    }, deps);
    expect(result).toEqual({ status: "start_over", mode: "custom" });
    expect(deps.loadDraft).not.toHaveBeenCalled();
  });

  it("routes a fresh build command back through automatic template selection", async () => {
    const deps = dependencies();
    const result = await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "make store", expectedDraftVersionId: BASE,
    }, deps);
    expect(result).toEqual({ status: "start_over", mode: "auto" });
    expect(deps.loadDraft).not.toHaveBeenCalled();
    expect(deps.compileStructuralPatch).not.toHaveBeenCalled();
  });
});

describe("createDefaultStructuralPatchCompiler", () => {
  it("retries one malformed structured result and accounts for both calls", async () => {
    const operation = {
      kind: "replaceTextChildren" as const,
      routeId: "home" as const,
      targetId: "region-1",
      value: "Updated copy",
      expected: `sha256:${"a".repeat(64)}`,
    };
    const provider = { complete: vi.fn()
      .mockResolvedValueOnce({ value: {}, provider: "fixture", model: "fixture-model", usage: { inputTokens: 4, outputTokens: 2 } })
      .mockResolvedValueOnce({ value: { operations: [operation] }, provider: "fixture", model: "fixture-model", usage: { inputTokens: 5, outputTokens: 3 } }) };

    const result = await createDefaultStructuralPatchCompiler(provider)({
      prompt: "Rewrite the section",
      bundle: baseBundle(),
    });

    expect(result.operations).toEqual([operation]);
    expect(result.provider.usage).toEqual({ inputTokens: 9, outputTokens: 5 });
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it("accepts store-wide patches beyond the old 12-operation compiler cap", async () => {
    const operations = Array.from({ length: 13 }, (_, index) => ({
      kind: "replaceTextChildren" as const,
      routeId: "home" as const,
      targetId: `region-${index}`,
      value: `Copy ${index}`,
      expected: `sha256:${"a".repeat(64)}`,
    }));
    const provider = { complete: vi.fn().mockResolvedValue({
      value: { operations },
      provider: "fixture", model: "fixture-model", usage: { inputTokens: 1, outputTokens: 1 },
    }) };

    const result = await createDefaultStructuralPatchCompiler(provider)({
      prompt: "Revamp the whole store",
      bundle: baseBundle(),
    });

    expect(result.operations).toHaveLength(13);
    expect(provider.complete).toHaveBeenCalledWith(expect.objectContaining({
      schema: expect.objectContaining({
        properties: expect.objectContaining({
          operations: expect.objectContaining({ maxItems: 32 }),
        }),
      }),
    }));
  });

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
      system: expect.stringContaining("Trusted commerce hosts use data-cd-slot, never data-cd-trusted-slot-id"),
    }));
    expect(vi.mocked(provider.complete).mock.calls[0]![0].system).toContain("Never emit compiler-owned output markers such as data-cd-repeat-id");
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

  it("provides authoring metadata for compiled trusted slot IDs", async () => {
    const bundle = baseBundle();
    const slot = bundle.routes.product.trustedSlots[0]!;
    const provider = { complete: vi.fn().mockResolvedValue({
      value: { operations: [{
        kind: "replaceRegion", routeId: "product", targetId: slot.id,
        expected: `sha256:${"a".repeat(64)}`,
        source: { html: `<div data-cd-slot="${slot.kind}" data-cd-host-size="${slot.hostSize}"></div>`, css: "" },
      }] },
      provider: "fixture", model: "fixture-model", usage: { inputTokens: 1, outputTokens: 1 },
    }) };

    await createDefaultStructuralPatchCompiler(provider)({
      prompt: "Redesign the purchase area", context: { routeId: "product", regionId: slot.id }, bundle,
    });

    const prompt = vi.mocked(provider.complete).mock.calls[0]![0].prompt;
    expect(prompt).toContain(`product ${slot.id}: data-cd-slot="${slot.kind}"`);
    expect(prompt).toContain(`data-cd-host-size="${slot.hostSize}"`);
  });

  it("enforces selected region scope while allowing unscoped patches spanning routes", async () => {
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
    const result = await createDefaultStructuralPatchCompiler(genericProvider)({ prompt: "Revamp store", bundle });
    expect(result.operations.map((operation) => "routeId" in operation ? operation.routeId : null)).toEqual(["home", "product"]);
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
    vi.mocked(deps.hashArtifact).mockResolvedValue(`sha256:${"a".repeat(64)}`);
    vi.mocked(deps.loadProofAssets).mockResolvedValue(verifiedBytes);
    const result = await undoStorefrontEdit({
      shopId: SHOP, actorId: ACTOR, expectedDraftVersionId: RESULT, targetVersionId: BASE,
    }, deps);
    expect(result).toEqual({ status: "installed", versionId: RESTORED, undoneVersionId: RESULT });
    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "custom",
      status: "candidate",
      resolution: { kind: "undo", restoredFromVersionId: BASE, undoneVersionId: RESULT, excludedTemplateIds: [] },
    }));
    expect(deps.cloneAssetProvenance).toHaveBeenCalledWith({ shopId: SHOP, sourceVersionId: BASE, targetVersionId: RESTORED });
    expect(deps.loadProofAssets).toHaveBeenCalledWith({ shopId: SHOP, versionId: BASE, manifest: target.assets });
    expect(deps.prove).toHaveBeenCalledWith(expect.objectContaining({ persistedAssets: verifiedBytes }));
    const hashedArtifact = vi.mocked(deps.hashArtifact).mock.calls[0]![0].artifact;
    expect(hashedArtifact).toEqual({ sourceKind: target.source.kind, bundle: target });
    expect(vi.mocked(deps.createVersion).mock.calls[0]![0].artifact).toBe(hashedArtifact);
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

  it("preserves the target B exclusions when undoing C so the next design cannot return to A", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadDraft).mockResolvedValue({
      versionId: RESULT,
      artifactHash: `sha256:${"b".repeat(64)}`,
      bundle: baseBundle(),
      resolution: { excludedTemplateIds: ["atelier-nine", "soft-chemistry"] },
    });
    vi.mocked(deps.loadVersion).mockResolvedValue({
      versionId: BASE,
      artifactHash: `sha256:${"a".repeat(64)}`,
      bundle: baseBundle(),
      resolution: { excludedTemplateIds: ["atelier-nine"] },
    });
    vi.mocked(deps.hashArtifact).mockResolvedValue(`sha256:${"a".repeat(64)}`);
    vi.mocked(deps.createVersion).mockResolvedValue(RESTORED);

    await undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps);

    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      resolution: {
        kind: "undo",
        restoredFromVersionId: BASE,
        undoneVersionId: RESULT,
        excludedTemplateIds: ["atelier-nine"],
      },
    }));
  });

  it("rejects an undo when the target bundle no longer matches its immutable artifact hash", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadDraft).mockResolvedValue({
      versionId: RESULT,
      artifactHash: `sha256:${"b".repeat(64)}`,
      bundle: baseBundle(),
    });
    vi.mocked(deps.loadVersion).mockResolvedValue({
      versionId: BASE,
      artifactHash: `sha256:${"a".repeat(64)}`,
      bundle: baseBundle(),
    });
    vi.mocked(deps.hashArtifact).mockResolvedValue(`sha256:${"c".repeat(64)}`);

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      actorId: ACTOR,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_undo_target_invalid", status: 409 });

    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
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

  it("stops an undo after browser proof observes cancellation", async () => {
    const controller = new AbortController();
    const deps = dependencies();
    vi.mocked(deps.loadDraft).mockResolvedValue({ versionId: RESULT, artifactHash: `sha256:${"b".repeat(64)}`, bundle: baseBundle() });
    vi.mocked(deps.prove).mockImplementation(async () => {
      controller.abort();
      return { ok: true, diagnostics: [], screenshots: ["proof"], browserMs: 1 };
    });

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
      signal: controller.signal,
    }, deps)).rejects.toMatchObject({ code: "storefront_edit_cancelled", status: 409 });

    expect(deps.prove).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(deps.hashArtifact).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("never performs the undo CAS when cancellation follows version creation", async () => {
    const controller = new AbortController();
    const deps = dependencies();
    vi.mocked(deps.loadDraft).mockResolvedValue({ versionId: RESULT, artifactHash: `sha256:${"b".repeat(64)}`, bundle: baseBundle() });
    vi.mocked(deps.hashArtifact).mockResolvedValue(`sha256:${"a".repeat(64)}`);
    vi.mocked(deps.createVersion).mockImplementation(async () => {
      controller.abort();
      return RESTORED;
    });

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
      signal: controller.signal,
    }, deps)).rejects.toMatchObject({ code: "storefront_edit_cancelled", status: 409 });

    expect(deps.cloneAssetProvenance).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("returns committed success when cancellation races with the terminal Undo CAS", async () => {
    const controller = new AbortController();
    const deps = dependencies();
    vi.mocked(deps.loadDraft).mockResolvedValue({ versionId: RESULT, artifactHash: `sha256:${"b".repeat(64)}`, bundle: baseBundle() });
    vi.mocked(deps.hashArtifact).mockResolvedValue(`sha256:${"a".repeat(64)}`);
    vi.mocked(deps.createVersion).mockResolvedValue(RESTORED);
    vi.mocked(deps.editDraft).mockImplementation(async () => {
      controller.abort();
      return RESTORED;
    });

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
      signal: controller.signal,
    }, deps)).resolves.toEqual({ status: "installed", versionId: RESTORED, undoneVersionId: RESULT });
    expect(deps.editDraft).toHaveBeenCalledWith(expect.not.objectContaining({ signal: expect.anything() }));
  });
});
