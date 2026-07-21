import { beforeEach, describe, expect, it, vi } from "vitest";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import { undoStorefrontEdit, type StorefrontUndoDependencies } from "./undo.server";
import { authoringFromRecipe } from "~/lib/storefront-ai/authoring.server";
import { CUSTOM_BENCH_RECIPE } from "~/lib/storefront-recipes/custom-bench/bundle";
import { StorefrontReleaseError } from "~/lib/storefront-bundle/release.server";

const defaultPath = vi.hoisted(() => ({
  getSupabase: vi.fn(),
  hashArtifact: vi.fn(),
  createVersion: vi.fn(),
  editDraft: vi.fn(),
  restoreCustomVersion: vi.fn(),
  loadProofContext: vi.fn(),
  prove: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: defaultPath.getSupabase }));
vi.mock("~/lib/storefront-bundle/release.server", () => ({
  StorefrontReleaseError: class StorefrontReleaseError extends Error {
    constructor(public readonly code: string, message: string, public readonly status: number) {
      super(message);
      this.name = "StorefrontReleaseError";
    }
  },
  hashStorefrontArtifact: defaultPath.hashArtifact,
  createStorefrontBundleVersion: defaultPath.createVersion,
  editStorefrontDraft: defaultPath.editDraft,
  restoreStorefrontCustomVersion: defaultPath.restoreCustomVersion,
}));
vi.mock("~/lib/storefront-ai/context.server", () => ({
  assembleStorefrontContextWithReferences: defaultPath.loadProofContext,
}));
vi.mock("~/lib/storefront-validation/browser.server", () => ({
  storefrontAiBrowserProof: defaultPath.prove,
}));

const SHOP = "11111111-1111-1111-1111-111111111111";
const BASE = "33333333-3333-3333-3333-333333333333";
const RESULT = "44444444-4444-4444-4444-444444444444";
const RESTORED = "55555555-5555-5555-5555-555555555555";
const PRODUCT = "66666666-6666-4666-8666-666666666666";
const PRODUCT_REF = "product-001";
const BASE_HASH = `sha256:${"a".repeat(64)}`;
const RESULT_HASH = `sha256:${"b".repeat(64)}`;

function bundle() {
  const value = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
  value.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
  return value;
}

function customArtifact() {
  return authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
    generationId: "generation-target",
    promptHash: `sha256:${"d".repeat(64)}`,
    derivedFromVersionId: BASE,
  });
}

function dependencies(): StorefrontUndoDependencies {
  const value = bundle();
  return {
    loadDraft: vi.fn().mockResolvedValue({ versionId: RESULT, artifactHash: `sha256:${"b".repeat(64)}`, bundle: value, resolution: {} }),
    loadVersion: vi.fn().mockResolvedValue({ versionId: BASE, artifactHash: `sha256:${"a".repeat(64)}`, bundle: value, resolution: {} }),
    loadEditAudit: vi.fn().mockResolvedValue({ baseVersionId: BASE, resultVersionId: RESULT }),
    validate: vi.fn().mockReturnValue({ profileVersion: 1, ok: true, diagnostics: [] }),
    loadProofContext: vi.fn().mockResolvedValue({
      context: { fingerprint: "proof", products: [] } as never,
      references: { products: {}, collections: {}, assets: {} },
    }),
    prove: vi.fn().mockResolvedValue({ ok: true, diagnostics: [], screenshots: ["proof"], browserMs: 1 }),
    hashArtifact: vi.fn().mockResolvedValue(`sha256:${"a".repeat(64)}`),
    createVersion: vi.fn().mockResolvedValue(RESTORED),
    editDraft: vi.fn().mockResolvedValue(RESTORED),
    restoreCustomVersion: vi.fn().mockResolvedValue(RESTORED),
  };
}

function referencedProofContext(mapped = true) {
  const products: Record<string, { id: string; handle: string }> = mapped
    ? { [PRODUCT_REF]: { id: PRODUCT, handle: "product" } }
    : {};
  return {
    context: { fingerprint: "proof", products: [{ id: PRODUCT_REF }] } as never,
    references: {
      products,
      collections: {},
      assets: {},
    },
  };
}

function databaseWithTarget(targetArtifact: object) {
  const currentBundle = bundle();
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (field: string, value: unknown) => {
          filters[field] = value;
          return query;
        },
        maybeSingle: async () => {
          if (table === "storefront_release") {
            return { data: { draft_version_id: RESULT }, error: null };
          }
          if (table === "storefront_bundle_edit") {
            return { data: { base_version_id: BASE, result_version_id: RESULT }, error: null };
          }
          if (table === "storefront_bundle_version") {
            const target = filters.id === BASE;
            return {
              data: {
                id: target ? BASE : RESULT,
                artifact_hash: target ? BASE_HASH : RESULT_HASH,
                bundle_json: target ? targetArtifact : currentBundle,
                resolution_json: {},
                runtime_version: 1,
                status: "validated",
              },
              error: null,
            };
          }
          throw new Error(`Unexpected table ${table}`);
        },
      };
      return query;
    },
  };
}

function configureDefaultPath(targetArtifact: object): void {
  defaultPath.getSupabase.mockReturnValue(databaseWithTarget(targetArtifact));
  defaultPath.hashArtifact.mockResolvedValue(BASE_HASH);
  defaultPath.createVersion.mockResolvedValue(RESTORED);
  defaultPath.editDraft.mockResolvedValue(RESTORED);
  defaultPath.restoreCustomVersion.mockResolvedValue(RESTORED);
  defaultPath.loadProofContext.mockResolvedValue({
    context: { fingerprint: "proof", products: [] },
    references: { products: {}, collections: {}, assets: {} },
  });
  defaultPath.prove.mockResolvedValue({ ok: true, diagnostics: [], screenshots: ["proof"], browserMs: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("undoStorefrontEdit", () => {
  it.each([
    ["modern custom", () => customArtifact()],
    ["source-kind envelope", () => {
      const value = customArtifact().bundle;
      return { sourceKind: value.source.kind, bundle: value };
    }],
    ["bundle-only envelope", () => ({ bundle: customArtifact().bundle })],
    ["bare bundle", () => customArtifact().bundle],
  ])("preserves the exact stored %s artifact through load, hash, and recreation", async (_label, artifactFactory) => {
    const artifact = artifactFactory();
    configureDefaultPath(artifact);

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    })).resolves.toEqual({ status: "installed", versionId: RESTORED, undoneVersionId: RESULT });

    expect(defaultPath.hashArtifact.mock.calls[0]![0].artifact).toBe(artifact);
    expect(defaultPath.restoreCustomVersion.mock.calls[0]![0]).toEqual(expect.objectContaining({
      baseVersionId: RESULT,
      targetVersionId: BASE,
      expectedDraftVersionId: RESULT,
      baseArtifactHash: RESULT_HASH,
      targetArtifactHash: BASE_HASH,
    }));
    expect(defaultPath.restoreCustomVersion.mock.calls[0]![0].artifact).toBe(artifact);
    expect(defaultPath.createVersion).not.toHaveBeenCalled();
    expect(defaultPath.editDraft).not.toHaveBeenCalled();
  });

  it("rejects malformed stored authoring through the database loader before hash or recreation", async () => {
    const valid = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
      generationId: "generation-target",
      promptHash: `sha256:${"d".repeat(64)}`,
      derivedFromVersionId: BASE,
    });
    configureDefaultPath({ ...valid, authoring: { version: 1 } });

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    })).rejects.toMatchObject({ code: "storefront_undo_target_missing", status: 409 });

    expect(defaultPath.hashArtifact).not.toHaveBeenCalled();
    expect(defaultPath.createVersion).not.toHaveBeenCalled();
    expect(defaultPath.restoreCustomVersion).not.toHaveBeenCalled();
  });

  it("restores only the recorded audit base through a fresh immutable version", async () => {
    const deps = dependencies();
    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).resolves.toEqual({ status: "installed", versionId: RESTORED, undoneVersionId: RESULT });

    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "recipe",
      status: "validated",
      resolution: {
        kind: "undo",
        restoredFromVersionId: BASE,
        undoneVersionId: RESULT,
        excludedTemplateIds: [],
      },
    }));
    expect(deps.editDraft).toHaveBeenCalledWith(expect.objectContaining({
      baseVersionId: RESULT,
      resultVersionId: RESTORED,
      patch: { operations: [{ kind: "restoreVersion", versionId: BASE }] },
    }));
  });

  it("proves a merchandising undo target with owned product IDs", async () => {
    const deps = dependencies();
    const target = await deps.loadVersion(SHOP, BASE);
    target!.bundle.featuredProductIds = [PRODUCT];
    vi.mocked(deps.loadVersion).mockResolvedValue(target);
    vi.mocked(deps.loadProofContext).mockResolvedValue(referencedProofContext());

    await undoStorefrontEdit({ shopId: SHOP, expectedDraftVersionId: RESULT, targetVersionId: BASE }, deps);

    expect(deps.prove).toHaveBeenCalledWith(expect.objectContaining({
      bundle: expect.objectContaining({ featuredProductIds: [PRODUCT] }),
      context: expect.objectContaining({ products: [{ id: PRODUCT }] }),
    }));
  });

  it("requests an undo target's featured products outside the ordinary proof sample", async () => {
    const deps = dependencies();
    const target = await deps.loadVersion(SHOP, BASE);
    target!.bundle.featuredProductIds = [PRODUCT];
    vi.mocked(deps.loadVersion).mockResolvedValue(target);
    vi.mocked(deps.loadProofContext).mockImplementation(async (input: { requiredProductIds?: string[] }) =>
      input.requiredProductIds?.includes(PRODUCT)
        ? referencedProofContext()
        : { context: { fingerprint: "proof", products: [] } as never, references: { products: {}, collections: {}, assets: {} } });

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).resolves.toMatchObject({ status: "installed" });
    expect(deps.loadProofContext).toHaveBeenCalledWith(expect.objectContaining({ requiredProductIds: [PRODUCT] }));
    expect(deps.prove).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ products: [{ id: PRODUCT }] }),
    }));
  });

  it("rejects an unmapped proof product before proof or persistence", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadProofContext).mockResolvedValue(referencedProofContext(false));

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_command_invalid", status: 422 });

    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("preserves the restored version's design exclusions", async () => {
    const deps = dependencies();
    const target = await deps.loadVersion(SHOP, BASE);
    vi.mocked(deps.loadVersion).mockResolvedValue({
      ...target!,
      resolution: { excludedTemplateIds: ["atelier-nine", "atelier-nine", "missing"] },
    });

    await undoStorefrontEdit({ shopId: SHOP, expectedDraftVersionId: RESULT, targetVersionId: BASE }, deps);

    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({
      resolution: expect.objectContaining({ excludedTemplateIds: ["atelier-nine"] }),
    }));
  });

  it("rejects a target that is not the recorded edit base before proof or writes", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadEditAudit).mockResolvedValue({ baseVersionId: RESTORED, resultVersionId: RESULT });

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_undo_target_invalid", status: 409 });

    expect(deps.prove).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("rejects a target whose immutable artifact hash no longer matches", async () => {
    const deps = dependencies();
    vi.mocked(deps.hashArtifact).mockResolvedValue(`sha256:${"c".repeat(64)}`);

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_undo_target_invalid", status: 409 });

    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("restores a modern custom target with its complete authoring artifact", async () => {
    const deps = dependencies();
    const artifact = customArtifact();
    vi.mocked(deps.loadDraft).mockResolvedValue({
      versionId: RESULT, artifactHash: `sha256:${"b".repeat(64)}`,
      artifact, bundle: artifact.bundle, resolution: {},
    });
    vi.mocked(deps.loadVersion).mockResolvedValue({
      versionId: BASE, artifactHash: `sha256:${"a".repeat(64)}`,
      artifact, bundle: artifact.bundle, resolution: {},
    });

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).resolves.toMatchObject({ status: "installed" });

    expect(deps.hashArtifact).toHaveBeenCalledWith(expect.objectContaining({ artifact }));
    expect(deps.restoreCustomVersion).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.restoreCustomVersion).mock.calls[0]![0].artifact).toBe(artifact);
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("restores a recipe target from a custom current draft", async () => {
    const deps = dependencies();
    const currentArtifact = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
      generationId: "generation-current",
      promptHash: `sha256:${"e".repeat(64)}`,
      derivedFromVersionId: RESULT,
    });
    vi.mocked(deps.loadDraft).mockResolvedValue({
      versionId: RESULT, artifactHash: `sha256:${"b".repeat(64)}`,
      artifact: currentArtifact, bundle: currentArtifact.bundle, resolution: {},
    });

    await expect(undoStorefrontEdit({
      shopId: SHOP, expectedDraftVersionId: RESULT, targetVersionId: BASE,
    }, deps)).resolves.toMatchObject({ status: "installed" });
    expect(deps.createVersion).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "recipe" }));
  });

  it("restores a legacy custom target without inventing authoring source", async () => {
    const deps = dependencies();
    const target = await deps.loadVersion(SHOP, BASE);
    const legacyBundle = structuredClone(target!.bundle);
    legacyBundle.source = { kind: "custom", generationId: "legacy", promptHash: "sha256:legacy" };
    const artifact = legacyBundle;
    vi.mocked(deps.loadVersion).mockResolvedValue({ ...target!, artifact, bundle: legacyBundle });

    await expect(undoStorefrontEdit({
      shopId: SHOP, expectedDraftVersionId: RESULT, targetVersionId: BASE,
    }, deps)).resolves.toMatchObject({ status: "installed" });

    expect(deps.restoreCustomVersion).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.restoreCustomVersion).mock.calls[0]![0].artifact).toBe(artifact);
    expect(vi.mocked(deps.restoreCustomVersion).mock.calls[0]![0].artifact).not.toHaveProperty("authoring");
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("leaves a custom draft unchanged when the atomic restore rejects", async () => {
    const deps = dependencies();
    const artifact = customArtifact();
    vi.mocked(deps.loadVersion).mockResolvedValue({
      versionId: BASE,
      artifactHash: BASE_HASH,
      artifact,
      bundle: artifact.bundle,
      resolution: {},
    });
    vi.mocked(deps.restoreCustomVersion).mockRejectedValue(new StorefrontReleaseError(
      "storefront_edit_conflict",
      "The storefront draft changed before undo.",
      409,
    ));

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_edit_conflict", status: 409 });

    expect(deps.restoreCustomVersion).toHaveBeenCalledOnce();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("stops before persistence when browser proof observes cancellation", async () => {
    const deps = dependencies();
    const controller = new AbortController();
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

    expect(deps.hashArtifact).not.toHaveBeenCalled();
    expect(deps.createVersion).not.toHaveBeenCalled();
    expect(deps.editDraft).not.toHaveBeenCalled();
  });

  it("returns committed success when cancellation races with the terminal undo CAS", async () => {
    const deps = dependencies();
    const controller = new AbortController();
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

  it("surfaces a terminal undo CAS rejection instead of reporting success", async () => {
    const deps = dependencies();
    vi.mocked(deps.editDraft).mockRejectedValue(new StorefrontReleaseError(
      "storefront_edit_conflict",
      "The storefront draft changed before undo.",
      409,
    ));

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).rejects.toMatchObject({
      code: "storefront_edit_conflict",
      status: 409,
      message: "The storefront draft changed before undo.",
    });

    expect(deps.createVersion).toHaveBeenCalledOnce();
    expect(deps.editDraft).toHaveBeenCalledOnce();
  });
});
