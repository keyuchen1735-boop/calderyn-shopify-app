import { describe, expect, it, vi } from "vitest";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import { undoStorefrontEdit, type StorefrontUndoDependencies } from "./undo.server";

const SHOP = "11111111-1111-1111-1111-111111111111";
const BASE = "33333333-3333-3333-3333-333333333333";
const RESULT = "44444444-4444-4444-4444-444444444444";
const RESTORED = "55555555-5555-5555-5555-555555555555";
const PRODUCT = "66666666-6666-4666-8666-666666666666";
const PRODUCT_REF = "product-001";

function bundle() {
  const value = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
  value.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
  return value;
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

describe("undoStorefrontEdit", () => {
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

  it("reports a legacy undo target as unavailable rather than a CAS conflict", async () => {
    const deps = dependencies();
    const target = await deps.loadVersion(SHOP, BASE);
    const legacy = structuredClone(target!);
    legacy.bundle.source = { kind: "custom", generationId: "legacy", promptHash: "sha256:legacy" };
    vi.mocked(deps.loadVersion).mockResolvedValue(legacy);

    await expect(undoStorefrontEdit({
      shopId: SHOP,
      expectedDraftVersionId: RESULT,
      targetVersionId: BASE,
    }, deps)).rejects.toMatchObject({ code: "storefront_command_unavailable", status: 503 });
    expect(deps.prove).not.toHaveBeenCalled();
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
});
