import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStorefrontBundleVersion,
  editStorefrontDraft,
  installStorefrontCustomRedesign,
  installStorefrontDraft,
  publishStorefrontRelease,
  restoreStorefrontCustomVersion,
  rollbackStorefrontRelease,
  validateStorefrontBundleVersion,
} from "./release.server";
import type { StorefrontReleaseError } from "./release.server";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";

const { rpc, from, versionResult, hasRunningExperiment, abortSignal } = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  versionResult: { current: { data: null as unknown, error: null as unknown } },
  hasRunningExperiment: vi.fn(),
  abortSignal: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc, from }) }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({ hasRunningExperiment }));

const SHOP = "11111111-1111-1111-1111-111111111111";
const VERSION = "22222222-2222-2222-2222-222222222222";
const BASE = "33333333-3333-3333-3333-333333333333";
const REDESIGN_MIGRATION = readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations/20260720233809_storefront_atomic_custom_redesign.sql",
), "utf8").toLowerCase();

const redesignInput = () => {
  const source = structuredClone(VALID_BUNDLE_SOURCE);
  return {
    shopId: SHOP,
    baseVersionId: BASE,
    expectedDraftVersionId: BASE,
    actorId: null,
    schemaVersion: 1,
    runtimeVersion: 1,
    validationProfileVersion: 1,
    resultArtifactHash: `sha256:${"b".repeat(64)}`,
    artifact: {
      sourceKind: "custom" as const,
      bundle: compileBundle(source).bundle,
      authoring: { version: 1 as const, source, overrides: {} },
    },
    assetManifest: { entries: [] },
    validationReport: { valid: true, profileVersion: 1 },
    generationPrompt: "Move the product grid above the story",
    resolution: { kind: "structural_edit" },
    baseArtifactHash: `sha256:${"a".repeat(64)}`,
    prompt: "Move the product grid above the story",
    scope: { mode: "structural_edit", routeId: "home" },
    patch: { mode: "structural_edit", changedRouteIds: ["home"] },
    provider: { kind: "anthropic", model: "configured", calls: [] },
    validation: { valid: true, profileVersion: 1, browserProof: { ok: true } },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  hasRunningExperiment.mockResolvedValue(false);
  rpc.mockImplementation(async (name: string) => ({
    data: name === "hash_storefront_artifact" ? `sha256:${"a".repeat(64)}` : VERSION,
    error: null,
  }));
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = () => Promise.resolve(versionResult.current);
  chain.abortSignal = abortSignal;
  abortSignal.mockImplementation(() => chain);
  from.mockReturnValue(chain);
  versionResult.current = {
    data: {
      runtime_version: 1,
      status: "validated",
      bundle_json: { sourceKind: "custom", bundle: compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle },
    },
    error: null,
  };
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

  it("preserves a generic SQLSTATE 40001 as a trusted 409 fallback conflict", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "serialization failure", code: "40001" } });
    await expect(publishStorefrontRelease({
      shopId: SHOP,
      expectedDraftVersionId: VERSION,
      expectedPublishedVersionId: BASE,
    })).rejects.toEqual(expect.objectContaining<Partial<StorefrontReleaseError>>({
      code: "storefront_publish_failed",
      status: 409,
    }));
  });

  it("passes compare-and-swap pointers to install, publish, and rollback RPCs", async () => {
    await installStorefrontDraft({ shopId: SHOP, versionId: VERSION, expectedDraftVersionId: BASE, actorId: null });
    await publishStorefrontRelease({ shopId: SHOP, expectedDraftVersionId: VERSION, expectedPublishedVersionId: BASE, actorId: null });
    await rollbackStorefrontRelease({ shopId: SHOP, targetVersionId: BASE, expectedPublishedVersionId: VERSION, actorId: null });
    expect(rpc).toHaveBeenNthCalledWith(1, "install_storefront_draft", expect.objectContaining({ p_expected_draft_version_id: BASE }));
    expect(rpc).toHaveBeenNthCalledWith(2, "publish_storefront_runtime1_release", expect.objectContaining({
      p_expected_draft_version_id: VERSION,
      p_expected_published_version_id: BASE,
    }));
    expect(rpc).toHaveBeenNthCalledWith(3, "rollback_storefront_release", expect.objectContaining({
      p_target_version_id: BASE,
      p_expected_published_version_id: VERSION,
    }));
  });

  it("refuses to publish a previously validated runtime-1 artifact that fails the current profile", async () => {
    const bundle = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
    bundle.routes.home.requiredData.push({ kind: "currentProduct" });
    versionResult.current = {
      data: { runtime_version: 1, status: "validated", bundle_json: { sourceKind: "custom", bundle } },
      error: null,
    };

    await expect(publishStorefrontRelease({
      shopId: SHOP,
      expectedDraftVersionId: VERSION,
      expectedPublishedVersionId: BASE,
    })).rejects.toMatchObject({ code: "storefront_bundle_revalidation_failed", status: 422 });
    expect(rpc).not.toHaveBeenCalledWith("publish_storefront_runtime1_release", expect.anything());
  });

  it("publishes a first runtime-1 release without creating a runtime-0 predecessor", async () => {
    await expect(publishStorefrontRelease({
      shopId: SHOP,
      expectedDraftVersionId: VERSION,
      expectedPublishedVersionId: null,
      actorId: null,
    })).resolves.toBe(VERSION);
    expect(rpc).toHaveBeenCalledWith("publish_storefront_runtime1_release", {
      p_shop_id: SHOP,
      p_expected_draft_version_id: VERSION,
      p_expected_published_version_id: null,
      p_actor_id: null,
    });
  });

  it("never publishes a runtime-0 draft", async () => {
    versionResult.current = {
      data: { runtime_version: 0, status: "validated", bundle_json: { sourceKind: "legacy" } },
      error: null,
    };

    await expect(publishStorefrontRelease({
      shopId: SHOP,
      expectedDraftVersionId: VERSION,
      expectedPublishedVersionId: BASE,
    })).rejects.toMatchObject({ code: "storefront_bundle_revalidation_failed", status: 422 });
    expect(rpc).not.toHaveBeenCalledWith("publish_storefront_runtime1_release", expect.anything());
  });

  it("returns fresh install success when cancellation races with the terminal CAS", async () => {
    const controller = new AbortController();
    rpc.mockImplementation(async (name: string) => {
      if (name === "install_storefront_draft") controller.abort();
      return { data: VERSION, error: null };
    });

    await expect(installStorefrontDraft({
      shopId: SHOP,
      versionId: VERSION,
      expectedDraftVersionId: null,
      signal: controller.signal,
    })).resolves.toBe(VERSION);
  });

  it("returns publish success when cancellation races with the terminal CAS", async () => {
    const controller = new AbortController();
    rpc.mockImplementation(async (name: string) => {
      if (name === "publish_storefront_runtime1_release") controller.abort();
      return { data: VERSION, error: null };
    });

    await expect(publishStorefrontRelease({
      shopId: SHOP,
      expectedDraftVersionId: VERSION,
      expectedPublishedVersionId: BASE,
      signal: controller.signal,
    })).resolves.toBe(VERSION);
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

  it("installs a complete custom redesign and its audit through one atomic RPC", async () => {
    const input = redesignInput();
    await expect(installStorefrontCustomRedesign(input)).resolves.toBe(VERSION);

    expect(hasRunningExperiment).toHaveBeenCalledWith(SHOP);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("install_storefront_custom_redesign", {
      p_shop_id: SHOP,
      p_base_version_id: BASE,
      p_expected_draft_version_id: BASE,
      p_actor_id: null,
      p_schema_version: input.artifact.bundle.schemaVersion,
      p_runtime_version: input.artifact.bundle.runtimeVersion,
      p_validation_profile_version: input.artifact.bundle.validationProfileVersion,
      p_result_artifact_hash: `sha256:${"b".repeat(64)}`,
      p_bundle_json: input.artifact,
      p_asset_manifest: input.artifact.bundle.assets,
      p_validation_report: input.validationReport,
      p_generation_prompt: input.generationPrompt,
      p_resolution_json: input.resolution,
      p_base_artifact_hash: input.baseArtifactHash,
      p_prompt: input.prompt,
      p_scope_json: { mode: "structural_edit", routeId: "home" },
      p_patch_json: input.patch,
      p_provider_json: input.provider,
      p_validation_json: input.validation,
    });
  });

  it("rejects release metadata that disagrees with the complete custom artifact", async () => {
    const mismatches: Array<(input: ReturnType<typeof redesignInput>) => void> = [
      (input) => { input.schemaVersion += 1; },
      (input) => { input.runtimeVersion += 1; },
      (input) => { input.validationProfileVersion += 1; },
      (input) => { Object.assign(input.assetManifest, { invented: true }); },
    ];

    for (const mismatch of mismatches) {
      const input = redesignInput();
      mismatch(input);
      await expect(installStorefrontCustomRedesign(input)).rejects.toMatchObject({
        code: "invalid_storefront_release",
        status: 422,
      });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps a stale custom redesign without issuing cleanup writes that could leave partial state", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "storefront_edit_conflict", code: "40001" } });

    await expect(installStorefrontCustomRedesign(redesignInput())).rejects.toMatchObject({
      code: "storefront_edit_conflict",
      status: 409,
    });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it.each([
    ["modern", () => redesignInput().artifact],
    ["legacy envelope", () => ({ bundle: redesignInput().artifact.bundle })],
    ["bare bundle", () => redesignInput().artifact.bundle],
  ])("atomically restores an exact %s custom artifact without inventing authoring", async (_label, artifact) => {
    const value = artifact();
    await expect(restoreStorefrontCustomVersion({
      shopId: SHOP,
      baseVersionId: VERSION,
      targetVersionId: BASE,
      expectedDraftVersionId: VERSION,
      baseArtifactHash: `sha256:${"b".repeat(64)}`,
      targetArtifactHash: `sha256:${"a".repeat(64)}`,
      artifact: value,
      validationReport: { valid: true, profileVersion: 1, browserProof: { ok: true } },
      resolution: { kind: "undo", restoredFromVersionId: BASE, undoneVersionId: VERSION },
    })).resolves.toBe(VERSION);

    const bundle = "bundle" in value ? value.bundle : value;
    expect(rpc).toHaveBeenCalledWith("restore_storefront_custom_version", {
      p_shop_id: SHOP,
      p_base_version_id: VERSION,
      p_target_version_id: BASE,
      p_expected_draft_version_id: VERSION,
      p_actor_id: null,
      p_schema_version: bundle.schemaVersion,
      p_runtime_version: bundle.runtimeVersion,
      p_validation_profile_version: bundle.validationProfileVersion,
      p_target_artifact_hash: `sha256:${"a".repeat(64)}`,
      p_bundle_json: value,
      p_asset_manifest: bundle.assets,
      p_validation_report: { valid: true, profileVersion: 1, browserProof: { ok: true } },
      p_resolution_json: { kind: "undo", restoredFromVersionId: BASE, undoneVersionId: VERSION },
      p_base_artifact_hash: `sha256:${"b".repeat(64)}`,
    });
    vi.clearAllMocks();
    hasRunningExperiment.mockResolvedValue(false);
  });

  it("rejects a custom restore envelope whose source kind disagrees with its runtime bundle", async () => {
    const artifact = redesignInput().artifact;
    await expect(restoreStorefrontCustomVersion({
      shopId: SHOP,
      baseVersionId: VERSION,
      targetVersionId: BASE,
      expectedDraftVersionId: VERSION,
      baseArtifactHash: `sha256:${"b".repeat(64)}`,
      targetArtifactHash: `sha256:${"a".repeat(64)}`,
      artifact: { ...artifact, sourceKind: "recipe" },
      validationReport: { valid: true },
      resolution: { kind: "undo" },
    })).rejects.toMatchObject({ code: "invalid_storefront_release", status: 422 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("creates, validates, audits, and swaps the draft in one rollback-safe SQL transaction", () => {
    const atomic = REDESIGN_MIGRATION.match(
      /function public\.install_storefront_custom_redesign[\s\S]+?\$\$;/,
    )?.[0] ?? "";

    for (const operation of [
      "create_storefront_bundle_version",
      "clone_storefront_bundle_asset_provenance",
      "validate_storefront_bundle_version",
      "edit_storefront_draft",
    ]) expect(atomic).toContain(operation);
    expect(atomic).toMatch(/sourcekind' is distinct from 'custom'/);
    expect(atomic).toMatch(/jsonb_typeof\(p_bundle_json -> 'authoring'\) is distinct from 'object'/);
    expect(atomic).not.toMatch(/exception\s+when/);
    expect(REDESIGN_MIGRATION).toMatch(
      /revoke all on function public\.install_storefront_custom_redesign[^;]+from public, anon, authenticated/,
    );
    expect(REDESIGN_MIGRATION).toMatch(
      /grant execute on function public\.install_storefront_custom_redesign[^;]+to service_role/,
    );
  });

  it("verifies and atomically restores an existing custom target without requiring authoring", () => {
    const atomic = REDESIGN_MIGRATION.match(
      /function public\.restore_storefront_custom_version[\s\S]+?\$\$;/,
    )?.[0] ?? "";

    expect(atomic).toMatch(/source_kind = 'custom'/);
    expect(atomic).toMatch(/artifact_hash = p_target_artifact_hash/);
    expect(atomic).toMatch(/bundle_json = p_bundle_json/);
    expect(atomic).not.toContain("authoring");
    expect(atomic).toContain("undo storefront edit");
    expect(atomic).toContain("restoreversion");
    for (const operation of [
      "create_storefront_bundle_version",
      "clone_storefront_bundle_asset_provenance",
      "validate_storefront_bundle_version",
      "edit_storefront_draft",
    ]) expect(atomic).toContain(operation);
    expect(REDESIGN_MIGRATION).toMatch(
      /revoke all on function public\.restore_storefront_custom_version[^;]+from public, anon, authenticated/,
    );
    expect(REDESIGN_MIGRATION).toMatch(
      /grant execute on function public\.restore_storefront_custom_version[^;]+to service_role/,
    );
  });

  it("accepts a timed-out edit when the requested draft version committed", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "upstream request timeout" } });
    versionResult.current = { data: { draft_version_id: VERSION }, error: null };

    await expect(editStorefrontDraft({
      shopId: SHOP,
      resultVersionId: VERSION,
      baseVersionId: BASE,
      expectedDraftVersionId: BASE,
      baseArtifactHash: "sha256:base",
      resultArtifactHash: "sha256:result",
      prompt: "Switch design",
      scope: { operation: "select_design" },
      patch: { operation: "select_design" },
      provider: { kind: "bounded_classification" },
      validation: { valid: true },
    })).resolves.toBe(VERSION);
  });
});
