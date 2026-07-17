import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StorefrontBundleV1 } from "../storefront-bundle/types";
import { CUSTOM_BENCH_BUNDLE } from "../storefront-recipes/custom-bench/bundle";
import { createStoreCommandHarness } from "./command-harness.server";
import { storefrontProofContext } from "./fixtures";

const SHOP_ID = "11111111-1111-4111-8111-111111111111";

function hashBundle(bundle: StorefrontBundleV1): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(bundle)).digest("hex")}`;
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

  it("rejects a result whose supplied artifact hash does not match its immutable version", async () => {
    let corruptHash = false;
    const harness = createStoreCommandHarness({
      shopId: SHOP_ID,
      context: storefrontProofContext(),
      initialBundle: CUSTOM_BENCH_BUNDLE,
      classify: async () => ({ kind: "update_text", slot: "heroTitle", value: "A restored title" }),
      hashArtifact: async ({ artifact }) => corruptHash
        ? `sha256:${"0".repeat(64)}`
        : hashBundle((artifact as { bundle: StorefrontBundleV1 }).bundle),
    });
    const originalVersionId = harness.state().draft!.versionId;
    corruptHash = true;

    await expect(harness.prompt("Update the title"))
      .rejects.toMatchObject({ code: "storefront_command_conflict", status: 409 });

    expect(harness.state().draft?.versionId).toBe(originalVersionId);
    expect(harness.versionCount()).toBe(2);
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
