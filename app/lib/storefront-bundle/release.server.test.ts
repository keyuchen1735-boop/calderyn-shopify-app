import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStorefrontBundleVersion,
  editStorefrontDraft,
  installStorefrontDraft,
  publishStorefrontRelease,
  rollbackStorefrontRelease,
  validateStorefrontBundleVersion,
} from "./release.server";
import type { StorefrontReleaseError } from "./release.server";

const { rpc, hasRunningExperiment } = vi.hoisted(() => ({
  rpc: vi.fn(),
  hasRunningExperiment: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc }) }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({ hasRunningExperiment }));

const SHOP = "11111111-1111-1111-1111-111111111111";
const VERSION = "22222222-2222-2222-2222-222222222222";
const BASE = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  hasRunningExperiment.mockResolvedValue(false);
  rpc.mockImplementation(async (name: string) => ({
    data: name === "hash_storefront_artifact" ? `sha256:${"a".repeat(64)}` : VERSION,
    error: null,
  }));
});

describe("storefront bundle release repository", () => {
  it("persists a validated runtime-1 version only through the guarded RPC", async () => {
    await expect(createStorefrontBundleVersion({
      shopId: SHOP,
      sourceKind: "custom",
      status: "validated",
      schemaVersion: 1,
      runtimeVersion: 1,
      validationProfileVersion: 1,
      artifact: { sourceKind: "custom", bundle: { schemaVersion: 1 } },
      assetManifest: { entries: [] },
      validationReport: { valid: true },
      generationPrompt: "make it editorial",
      resolution: { kind: "custom" },
    })).resolves.toBe(VERSION);

    expect(hasRunningExperiment).toHaveBeenCalledWith(SHOP);
    expect(rpc).toHaveBeenNthCalledWith(1, "hash_storefront_artifact", expect.objectContaining({
      p_schema_version: 1,
      p_runtime_version: 1,
      p_validation_profile_version: 1,
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, "create_storefront_bundle_version", expect.objectContaining({
      p_shop_id: SHOP,
      p_source_kind: "custom",
      p_artifact_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      p_bundle_json: expect.objectContaining({ sourceKind: "custom" }),
    }));
  });

  it("never permits the generic creator to forge a legacy source", async () => {
    await expect(createStorefrontBundleVersion({
      shopId: SHOP,
      sourceKind: "legacy",
      status: "validated",
      schemaVersion: 1,
      runtimeVersion: 0,
      validationProfileVersion: 0,
      artifact: { sourceKind: "legacy" },
      assetManifest: { entries: [] },
      validationReport: { valid: true },
      resolution: { kind: "legacy_capture" },
    })).rejects.toMatchObject({ code: "legacy_source_requires_capture" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("validates an asset-bearing candidate only through the guarded transition RPC", async () => {
    await expect(validateStorefrontBundleVersion({
      shopId: SHOP,
      versionId: VERSION,
      artifactHash: `sha256:${"a".repeat(64)}`,
      validationReport: { valid: true, profileVersion: 1 },
    })).resolves.toBe(VERSION);
    expect(rpc).toHaveBeenCalledWith("validate_storefront_bundle_version", {
      p_shop_id: SHOP,
      p_version_id: VERSION,
      p_expected_artifact_hash: `sha256:${"a".repeat(64)}`,
      p_validation_report: { valid: true, profileVersion: 1 },
    });
  });

  it("refuses every runtime-1 write before calling PostgREST while an experiment is running", async () => {
    hasRunningExperiment.mockResolvedValue(true);
    await expect(installStorefrontDraft({ shopId: SHOP, versionId: VERSION, expectedDraftVersionId: null }))
      .rejects.toMatchObject({ code: "experiment_running" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps stale expected-pointer database failures to stable conflict errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "storefront_draft_conflict", code: "40001" } });
    await expect(installStorefrontDraft({ shopId: SHOP, versionId: VERSION, expectedDraftVersionId: BASE }))
      .rejects.toEqual(expect.objectContaining<Partial<StorefrontReleaseError>>({ code: "storefront_draft_conflict", status: 409 }));
  });

  it("passes compare-and-swap pointers to install, publish, and rollback RPCs", async () => {
    await installStorefrontDraft({ shopId: SHOP, versionId: VERSION, expectedDraftVersionId: BASE, actorId: null });
    await publishStorefrontRelease({ shopId: SHOP, expectedDraftVersionId: VERSION, expectedPublishedVersionId: BASE, actorId: null });
    await rollbackStorefrontRelease({ shopId: SHOP, targetVersionId: BASE, expectedPublishedVersionId: VERSION, actorId: null });
    expect(rpc).toHaveBeenNthCalledWith(1, "install_storefront_draft", expect.objectContaining({ p_expected_draft_version_id: BASE }));
    expect(rpc).toHaveBeenNthCalledWith(2, "publish_storefront_release", expect.objectContaining({
      p_expected_draft_version_id: VERSION,
      p_expected_published_version_id: BASE,
    }));
    expect(rpc).toHaveBeenNthCalledWith(3, "rollback_storefront_release", expect.objectContaining({
      p_target_version_id: BASE,
      p_expected_published_version_id: VERSION,
    }));
  });

  it("sends the complete replayable edit audit to the atomic edit RPC", async () => {
    await editStorefrontDraft({
      shopId: SHOP,
      resultVersionId: VERSION,
      baseVersionId: BASE,
      expectedDraftVersionId: BASE,
      baseArtifactHash: "sha256:base",
      resultArtifactHash: "sha256:result",
      prompt: "Make the hero quieter",
      scope: { route: "home", regionIds: ["hero"] },
      patch: { version: 1, operations: [{ kind: "text.replace", targetId: "hero-title" }] },
      provider: { kind: "deterministic", contractVersion: 1 },
      validation: { profileVersion: 1, valid: true },
      actorId: null,
    });
    expect(rpc).toHaveBeenCalledWith("edit_storefront_draft", expect.objectContaining({
      p_base_version_id: BASE,
      p_result_version_id: VERSION,
      p_base_artifact_hash: "sha256:base",
      p_result_artifact_hash: "sha256:result",
      p_prompt: "Make the hero quieter",
      p_scope_json: { route: "home", regionIds: ["hero"] },
      p_patch_json: expect.objectContaining({ version: 1 }),
      p_provider_json: expect.objectContaining({ kind: "deterministic" }),
      p_validation_json: expect.objectContaining({ valid: true }),
    }));
  });
});
