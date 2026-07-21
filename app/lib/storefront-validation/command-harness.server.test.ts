import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StorefrontBundleV1 } from "../storefront-bundle/types";
import { authoringFromRecipe } from "../storefront-ai/authoring.server";
import { CUSTOM_BENCH_BUNDLE, CUSTOM_BENCH_RECIPE } from "../storefront-recipes/custom-bench/bundle";
import { createStoreCommandHarness } from "./command-harness.server";
import { storefrontProofContext } from "./fixtures";

const SHOP_ID = "11111111-1111-4111-8111-111111111111";

function hashBundle(bundle: StorefrontBundleV1): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(bundle)).digest("hex")}`;
}

function redesignResult() {
  const artifact = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
    generationId: "generation-result",
    promptHash: `sha256:${"d".repeat(64)}`,
    derivedFromVersionId: "00000000-0000-4000-8000-000000000001",
  });
  return {
    artifact,
    validation: { profileVersion: 1 as const, ok: true, diagnostics: [] },
    browserProof: { ok: true, diagnostics: [], screenshots: [], browserMs: 0 },
    audit: {
      mode: "full_redesign" as const,
      baseVersionId: "00000000-0000-4000-8000-000000000001",
      generationId: "generation-result",
      promptHash: `sha256:${"d".repeat(64)}`,
      changedRouteIds: ["home" as const], shellChanged: true, repairs: 0, provider: [],
    },
  };
}

function redesignHarness(overrides: {
  redesign?: () => Promise<ReturnType<typeof redesignResult>>;
  editConflict?: () => boolean;
  isInstallable?: () => boolean;
} = {}) {
  return createStoreCommandHarness({
    shopId: SHOP_ID,
    context: storefrontProofContext(),
    initialBundle: CUSTOM_BENCH_BUNDLE,
    classify: async () => ({ kind: "full_redesign" }),
    redesign: overrides.redesign ?? (async () => redesignResult()),
    ...(overrides.editConflict ? { editConflict: overrides.editConflict } : {}),
    ...(overrides.isInstallable ? { isInstallable: overrides.isInstallable } : {}),
  });
}

function harnessWithProof(proofFails: () => boolean) {
  return createStoreCommandHarness({
    shopId: SHOP_ID,
    context: storefrontProofContext(),
    initialBundle: CUSTOM_BENCH_BUNDLE,
    classify: async () => ({ kind: "update_text", slot: "heroTitle", value: "A restored title" }),
    prove: async () => proofFails()
      ? {
          ok: false,
          diagnostics: [{ routeId: "home", code: "proof.failed", message: "proof failed", severity: "serious" }],
          screenshots: [],
          browserMs: 0,
        }
      : { ok: true, diagnostics: [], screenshots: [], browserMs: 0 },
  });
}

describe("store command proof harness", () => {
  it("leaves the edited draft installed when the Undo target fails browser proof", async () => {
    let proofFails = false;
    const harness = harnessWithProof(() => proofFails);
    const targetVersionId = harness.state().draft!.versionId;
    const edited = await harness.prompt("Update the title");
    proofFails = true;

    await expect(harness.run({
      kind: "undo",
      targetVersionId,
      expectedDraftVersionId: edited.versionId,
    })).rejects.toThrow();

    expect(harness.state().draft?.versionId).toBe(edited.versionId);
    expect(harness.versionCount()).toBe(2);
  });

  it("loses a stale Undo CAS after proof and immutable version creation without changing the draft", async () => {
    let proofCalls = 0;
    let conflictAtEdit = false;
    const harness = createStoreCommandHarness({
      shopId: SHOP_ID,
      context: storefrontProofContext(),
      initialBundle: CUSTOM_BENCH_BUNDLE,
      classify: async () => ({ kind: "update_text", slot: "heroTitle", value: "A restored title" }),
      prove: async () => {
        proofCalls += 1;
        return { ok: true, diagnostics: [], screenshots: [], browserMs: 0 };
      },
      editConflict: () => conflictAtEdit,
    });
    const targetVersionId = harness.state().draft!.versionId;
    const edited = await harness.prompt("Update the title");
    conflictAtEdit = true;

    await expect(harness.run({
      kind: "undo",
      targetVersionId,
      expectedDraftVersionId: edited.versionId,
    })).rejects.toMatchObject({ code: "storefront_command_conflict", status: 409 });

    expect(proofCalls).toBe(2);
    expect(harness.state().draft?.versionId).toBe(edited.versionId);
    expect(harness.versionCount()).toBe(3);
  });

  it("hashes exact artifact metadata once and reuses that result for install", async () => {
    const hashed: unknown[] = [];
    const harness = createStoreCommandHarness({
      shopId: SHOP_ID,
      context: storefrontProofContext(),
      initialBundle: CUSTOM_BENCH_BUNDLE,
      classify: async () => ({ kind: "update_text", slot: "heroTitle", value: "A restored title" }),
      hashArtifact: async (input) => {
        hashed.push(structuredClone(input));
        return hashBundle((input.artifact as { bundle: StorefrontBundleV1 }).bundle);
      },
    });

    await expect(harness.prompt("Update the title")).resolves.toMatchObject({ status: "installed" });

    expect(hashed).toHaveLength(1);
    expect(hashed[0]).toMatchObject({
      schemaVersion: 1, runtimeVersion: 1, validationProfileVersion: 1,
      artifact: { sourceKind: "recipe", bundle: expect.any(Object) },
      assetManifest: expect.any(Object),
    });
    expect(harness.versionCount()).toBe(2);
  });

  it("rolls back a late custom-install conflict without a version, edit, or pointer change", async () => {
    const harness = redesignHarness({ editConflict: () => true });
    const original = harness.state().draft!.versionId;

    await expect(harness.prompt("Redesign everything"))
      .rejects.toMatchObject({ code: "storefront_command_conflict", status: 409 });

    expect(harness.state().draft?.versionId).toBe(original);
    expect(harness.versionCount()).toBe(1);
    expect(harness.editCount()).toBe(0);
  });

  it("rejects custom artifacts with missing authoring or inconsistent assets", async () => {
    const missing = redesignResult();
    const missingHarness = redesignHarness({
      redesign: async () => ({ ...missing, artifact: { sourceKind: "custom", bundle: missing.artifact.bundle } } as never),
    });
    await expect(missingHarness.prompt("Redesign everything")).rejects.toMatchObject({ code: "storefront_command_conflict" });
    expect(missingHarness.versionCount()).toBe(1);

    const inconsistent = redesignResult();
    inconsistent.artifact.bundle = { ...inconsistent.artifact.bundle, assets: { entries: [] } };
    const assetHarness = redesignHarness({ redesign: async () => inconsistent });
    await expect(assetHarness.prompt("Redesign everything")).rejects.toMatchObject({ code: "storefront_command_conflict" });
    expect(assetHarness.versionCount()).toBe(1);
  });

  it("rejects custom installs that fail validation audit or installability", async () => {
    const invalid = redesignResult();
    invalid.validation.ok = false;
    const validationHarness = redesignHarness({ redesign: async () => invalid });
    await expect(validationHarness.prompt("Redesign everything")).rejects.toMatchObject({ code: "storefront_command_conflict" });
    expect(validationHarness.versionCount()).toBe(1);

    const installabilityHarness = redesignHarness({ isInstallable: () => false });
    await expect(installabilityHarness.prompt("Redesign everything")).rejects.toMatchObject({ code: "storefront_command_conflict" });
    expect(installabilityHarness.versionCount()).toBe(1);
    expect(installabilityHarness.editCount()).toBe(0);
  });

  it("refuses to install a newly created Undo version that is not installable", async () => {
    const harness = createStoreCommandHarness({
      shopId: SHOP_ID,
      context: storefrontProofContext(),
      initialBundle: CUSTOM_BENCH_BUNDLE,
      classify: async () => ({ kind: "update_text", slot: "heroTitle", value: "A restored title" }),
      isInstallable: ({ resolution }) => resolution.kind !== "undo",
    });
    const targetVersionId = harness.state().draft!.versionId;
    const edited = await harness.prompt("Update the title");

    await expect(harness.run({
      kind: "undo",
      targetVersionId,
      expectedDraftVersionId: edited.versionId,
    })).rejects.toMatchObject({ code: "storefront_command_conflict", status: 409 });

    expect(harness.state().draft?.versionId).toBe(edited.versionId);
    expect(harness.versionCount()).toBe(3);
  });
});
