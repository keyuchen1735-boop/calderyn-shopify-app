import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import { editStorefrontByPrompt, undoStorefrontEdit, type StorefrontEditDependencies } from "./edit.server";

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
    preflight: vi.fn().mockResolvedValue(undefined),
    compileStructuralPatch: vi.fn(),
    validate: vi.fn().mockReturnValue({ profileVersion: 1, ok: true, diagnostics: [] }),
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
      provider: { kind: "deterministic", model: null },
    }));
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
      operations: [{ kind: "replaceTextChildren", routeId: "home", targetId: homeTarget.id, value: "A new editorial opening" }],
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

  it("clones verified logical asset references before validating an edited custom version", async () => {
    const custom = baseBundle();
    custom.assets.entries = [{ key: "hero", contentHash: "b".repeat(64), mediaType: "image/webp", byteSize: 84 }];
    const deps = dependencies(custom);

    await editStorefrontByPrompt({
      shopId: SHOP, actorId: ACTOR, prompt: "Make the accent #ff5500", expectedDraftVersionId: BASE,
    }, deps);

    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "custom", status: "candidate" }));
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
    expect(deps.editDraft).not.toHaveBeenCalled();
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
    expect(result).toEqual({ status: "start_over" });
    expect(deps.loadDraft).not.toHaveBeenCalled();
  });
});

describe("undoStorefrontEdit", () => {
  it("creates a fresh immutable restore version with cloned provenance before the atomic undo CAS", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadDraft).mockResolvedValue({ versionId: RESULT, artifactHash: `sha256:${"b".repeat(64)}`, bundle: baseBundle() });
    vi.mocked(deps.createVersion).mockResolvedValue(RESTORED);
    vi.mocked(deps.validateVersion).mockResolvedValue(RESTORED);
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
    expect(deps.validateVersion).toHaveBeenCalledWith(expect.objectContaining({ versionId: RESTORED }));
    expect(deps.editDraft).toHaveBeenCalledWith(expect.objectContaining({
      baseVersionId: RESULT,
      resultVersionId: RESTORED,
      expectedDraftVersionId: RESULT,
      prompt: "Undo storefront edit",
      patch: { operations: [{ kind: "restoreVersion", versionId: BASE }] },
    }));
  });
});
