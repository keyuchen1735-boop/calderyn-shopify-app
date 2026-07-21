import { isDeepStrictEqual } from "node:util";
import { hasRunningExperiment } from "~/lib/experiments/store-experiment.server";
import { isUuid } from "~/lib/ids";
import { getSupabase } from "~/lib/supabase.server";
import { editAuditRpcParams, type StorefrontEditAuditInput } from "./edit-audit.server";
import { validateCompiledBundle } from "~/lib/storefront-compiler/validate";
import type { StorefrontAuthoringV1, StorefrontVersionArtifactV1 } from "~/lib/storefront-ai/authoring.server";
import type { StorefrontBundleV1 } from "~/lib/storefront-bundle/types";

export type StorefrontBundleSourceKind = "legacy" | "recipe" | "custom";
export type StorefrontBundleStatus = "candidate" | "validated" | "failed";

export class StorefrontReleaseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StorefrontReleaseError";
  }
}

function requireUuid(value: string, field: string): void {
  if (!isUuid(value)) throw new StorefrontReleaseError("invalid_storefront_release", `${field} must be a UUID`, 422);
}

function throwIfReleaseAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Storefront write cancelled", "AbortError");
}

export async function assertStorefrontWriteAllowed(shopId: string): Promise<void> {
  requireUuid(shopId, "shopId");
  if (await hasRunningExperiment(shopId)) {
    throw new StorefrontReleaseError(
      "experiment_running",
      "Finish or stop the running storefront experiment before changing this store.",
      409,
    );
  }
}

function rpcFailure(error: { message?: string; code?: string } | null, fallback: string): never {
  const message = error?.message ?? fallback;
  const known = [
    "storefront_draft_conflict",
    "storefront_edit_conflict",
    "storefront_publish_conflict",
    "storefront_rollback_conflict",
  ].find((code) => message.includes(code));
  if (known || error?.code === "40001") {
    throw new StorefrontReleaseError(known ?? fallback, message, 409, error);
  }
  if (message.includes("storefront_experiment_running")) {
    throw new StorefrontReleaseError("experiment_running", message, 409, error);
  }
  throw new StorefrontReleaseError(fallback, message, 500, error);
}

async function writeRpc<T>(name: string, params: Record<string, unknown>, fallback: string, signal?: AbortSignal): Promise<T> {
  const query = getSupabase().rpc(name, params);
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) rpcFailure(error, fallback);
  return data as T;
}

export interface CreateStorefrontBundleVersionInput {
  shopId: string;
  sourceKind: StorefrontBundleSourceKind;
  templateId?: string | null;
  templateVersion?: number | null;
  status: StorefrontBundleStatus;
  schemaVersion: number;
  runtimeVersion: number;
  validationProfileVersion: number;
  artifact: Record<string, unknown>;
  assetManifest: Record<string, unknown>;
  validationReport?: Record<string, unknown> | null;
  generationPrompt?: string | null;
  resolution: Record<string, unknown>;
  signal?: AbortSignal;
}

export async function createStorefrontBundleVersion(input: CreateStorefrontBundleVersionInput): Promise<string> {
  throwIfReleaseAborted(input.signal);
  if (input.sourceKind === "legacy") {
    throw new StorefrontReleaseError(
      "legacy_source_requires_capture",
      "Legacy versions can only be created by the validated capture path.",
      422,
    );
  }
  await assertStorefrontWriteAllowed(input.shopId);
  throwIfReleaseAborted(input.signal);
  const artifactHash = await hashStorefrontArtifact({
    schemaVersion: input.schemaVersion,
    runtimeVersion: input.runtimeVersion,
    validationProfileVersion: input.validationProfileVersion,
    artifact: input.artifact,
    assetManifest: input.assetManifest,
    signal: input.signal,
  });
  throwIfReleaseAborted(input.signal);
  const id = await writeRpc<string>("create_storefront_bundle_version", {
    p_shop_id: input.shopId,
    p_source_kind: input.sourceKind,
    p_template_id: input.templateId ?? null,
    p_template_version: input.templateVersion ?? null,
    p_status: input.status,
    p_schema_version: input.schemaVersion,
    p_runtime_version: input.runtimeVersion,
    p_validation_profile_version: input.validationProfileVersion,
    p_artifact_hash: artifactHash,
    p_bundle_json: input.artifact,
    p_asset_manifest: input.assetManifest,
    p_validation_report: input.validationReport ?? null,
    p_generation_prompt: input.generationPrompt ?? null,
    p_resolution_json: input.resolution,
  }, "storefront_bundle_create_failed", input.signal);
  requireUuid(id, "bundleVersionId");
  return id;
}

export interface HashStorefrontArtifactInput {
  schemaVersion: number;
  runtimeVersion: number;
  validationProfileVersion: number;
  artifact: Record<string, unknown>;
  assetManifest: Record<string, unknown>;
  signal?: AbortSignal;
}

export async function hashStorefrontArtifact(input: HashStorefrontArtifactInput): Promise<string> {
  const hash = await writeRpc<string>("hash_storefront_artifact", {
    p_schema_version: input.schemaVersion,
    p_runtime_version: input.runtimeVersion,
    p_validation_profile_version: input.validationProfileVersion,
    p_bundle_json: input.artifact,
    p_asset_manifest: input.assetManifest,
  }, "storefront_artifact_hash_failed", input.signal);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new StorefrontReleaseError("storefront_artifact_hash_failed", "Database returned an invalid artifact hash", 500);
  }
  return hash;
}

export interface ValidateStorefrontBundleVersionInput {
  shopId: string;
  versionId: string;
  artifactHash: string;
  validationReport: Record<string, unknown>;
}

export async function validateStorefrontBundleVersion(input: ValidateStorefrontBundleVersionInput): Promise<string> {
  await assertStorefrontWriteAllowed(input.shopId);
  requireUuid(input.versionId, "versionId");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.artifactHash)) {
    throw new StorefrontReleaseError("invalid_storefront_release", "artifactHash must be a canonical SHA-256 hash", 422);
  }
  return writeRpc<string>("validate_storefront_bundle_version", {
    p_shop_id: input.shopId,
    p_version_id: input.versionId,
    p_expected_artifact_hash: input.artifactHash,
    p_validation_report: input.validationReport,
  }, "storefront_bundle_validation_failed");
}

export interface InstallStorefrontDraftInput {
  shopId: string;
  versionId: string;
  expectedDraftVersionId: string | null;
  actorId?: string | null;
  signal?: AbortSignal;
}

export interface InstallStorefrontCustomRedesignInput extends StorefrontEditAuditInput {
  shopId: string;
  baseVersionId: string;
  expectedDraftVersionId: string;
  actorId?: string | null;
  schemaVersion: number;
  runtimeVersion: number;
  validationProfileVersion: number;
  resultArtifactHash: string;
  artifact: StorefrontVersionArtifactV1 & { sourceKind: "custom"; authoring: StorefrontAuthoringV1 };
  assetManifest: Record<string, unknown>;
  validationReport: Record<string, unknown>;
  generationPrompt?: string | null;
  resolution: Record<string, unknown>;
  signal?: AbortSignal;
}

export async function installStorefrontCustomRedesign(input: InstallStorefrontCustomRedesignInput): Promise<string> {
  throwIfReleaseAborted(input.signal);
  await assertStorefrontWriteAllowed(input.shopId);
  throwIfReleaseAborted(input.signal);
  requireUuid(input.baseVersionId, "baseVersionId");
  requireUuid(input.expectedDraftVersionId, "expectedDraftVersionId");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.resultArtifactHash)) {
    throw new StorefrontReleaseError("invalid_storefront_release", "resultArtifactHash must be a canonical SHA-256 hash", 422);
  }
  const bundle = input.artifact.bundle;
  if (input.schemaVersion !== bundle.schemaVersion
    || input.runtimeVersion !== bundle.runtimeVersion
    || input.validationProfileVersion !== bundle.validationProfileVersion
    || !isDeepStrictEqual(input.assetManifest, bundle.assets)) {
    throw new StorefrontReleaseError(
      "invalid_storefront_release",
      "Release metadata must match the complete storefront artifact",
      422,
    );
  }
  throwIfReleaseAborted(input.signal);
  const id = await writeRpc<string>("install_storefront_custom_redesign", {
    p_shop_id: input.shopId,
    p_base_version_id: input.baseVersionId,
    p_expected_draft_version_id: input.expectedDraftVersionId,
    p_actor_id: input.actorId ?? null,
    p_schema_version: bundle.schemaVersion,
    p_runtime_version: bundle.runtimeVersion,
    p_validation_profile_version: bundle.validationProfileVersion,
    p_bundle_json: input.artifact,
    p_asset_manifest: bundle.assets,
    p_validation_report: input.validationReport,
    p_generation_prompt: input.generationPrompt ?? null,
    p_resolution_json: input.resolution,
    ...editAuditRpcParams(input),
  }, "storefront_redesign_install_failed", input.signal);
  requireUuid(id, "bundleVersionId");
  return id;
}

export type StorefrontCustomRestoreArtifact =
  | StorefrontVersionArtifactV1
  | StorefrontBundleV1
  | { bundle: StorefrontBundleV1 };

export interface RestoreStorefrontCustomVersionInput {
  shopId: string;
  baseVersionId: string;
  targetVersionId: string;
  expectedDraftVersionId: string;
  actorId?: string | null;
  baseArtifactHash: string;
  targetArtifactHash: string;
  artifact: StorefrontCustomRestoreArtifact;
  validationReport: Record<string, unknown>;
  resolution: Record<string, unknown>;
  signal?: AbortSignal;
}

function customRestoreBundle(artifact: StorefrontCustomRestoreArtifact): StorefrontBundleV1 {
  const envelope = artifact as unknown as Record<string, unknown>;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || (Object.hasOwn(envelope, "sourceKind") && envelope.sourceKind !== "custom")) {
    throw new StorefrontReleaseError("invalid_storefront_release", "Custom restore artifact is invalid", 422);
  }
  const candidate = Object.hasOwn(envelope, "bundle") ? envelope.bundle : envelope;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new StorefrontReleaseError("invalid_storefront_release", "Custom restore bundle is invalid", 422);
  }
  const bundle = candidate as Record<string, unknown>;
  const source = bundle.source;
  if (!source || typeof source !== "object" || Array.isArray(source)
    || (source as Record<string, unknown>).kind !== "custom"
    || !Number.isInteger(bundle.schemaVersion)
    || !Number.isInteger(bundle.runtimeVersion)
    || !Number.isInteger(bundle.validationProfileVersion)
    || !bundle.assets || typeof bundle.assets !== "object" || Array.isArray(bundle.assets)) {
    throw new StorefrontReleaseError("invalid_storefront_release", "Custom restore bundle is invalid", 422);
  }
  return candidate as StorefrontBundleV1;
}

export async function restoreStorefrontCustomVersion(input: RestoreStorefrontCustomVersionInput): Promise<string> {
  throwIfReleaseAborted(input.signal);
  requireUuid(input.shopId, "shopId");
  requireUuid(input.baseVersionId, "baseVersionId");
  requireUuid(input.targetVersionId, "targetVersionId");
  requireUuid(input.expectedDraftVersionId, "expectedDraftVersionId");
  for (const [field, hash] of [
    ["baseArtifactHash", input.baseArtifactHash],
    ["targetArtifactHash", input.targetArtifactHash],
  ] as const) {
    if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
      throw new StorefrontReleaseError("invalid_storefront_release", `${field} must be a canonical SHA-256 hash`, 422);
    }
  }
  const bundle = customRestoreBundle(input.artifact);
  await assertStorefrontWriteAllowed(input.shopId);
  throwIfReleaseAborted(input.signal);
  const id = await writeRpc<string>("restore_storefront_custom_version", {
    p_shop_id: input.shopId,
    p_base_version_id: input.baseVersionId,
    p_target_version_id: input.targetVersionId,
    p_expected_draft_version_id: input.expectedDraftVersionId,
    p_actor_id: input.actorId ?? null,
    p_schema_version: bundle.schemaVersion,
    p_runtime_version: bundle.runtimeVersion,
    p_validation_profile_version: bundle.validationProfileVersion,
    p_target_artifact_hash: input.targetArtifactHash,
    p_bundle_json: input.artifact,
    p_asset_manifest: bundle.assets,
    p_validation_report: input.validationReport,
    p_resolution_json: input.resolution,
    p_base_artifact_hash: input.baseArtifactHash,
  }, "storefront_custom_restore_failed", input.signal);
  requireUuid(id, "bundleVersionId");
  return id;
}

export async function installStorefrontDraft(input: InstallStorefrontDraftInput): Promise<string> {
  throwIfReleaseAborted(input.signal);
  await assertStorefrontWriteAllowed(input.shopId);
  throwIfReleaseAborted(input.signal);
  requireUuid(input.versionId, "versionId");
  throwIfReleaseAborted(input.signal);
  return writeRpc<string>("install_storefront_draft", {
    p_shop_id: input.shopId,
    p_validated_version_id: input.versionId,
    p_expected_draft_version_id: input.expectedDraftVersionId,
    p_actor_id: input.actorId ?? null,
  }, "storefront_draft_install_failed");
}

export interface EditStorefrontDraftInput extends StorefrontEditAuditInput {
  shopId: string;
  resultVersionId: string;
  baseVersionId: string;
  expectedDraftVersionId: string;
  actorId?: string | null;
  signal?: AbortSignal;
}

export async function editStorefrontDraft(input: EditStorefrontDraftInput): Promise<string> {
  throwIfReleaseAborted(input.signal);
  await assertStorefrontWriteAllowed(input.shopId);
  throwIfReleaseAborted(input.signal);
  requireUuid(input.baseVersionId, "baseVersionId");
  requireUuid(input.resultVersionId, "resultVersionId");
  throwIfReleaseAborted(input.signal);
  try {
    return await writeRpc<string>("edit_storefront_draft", {
      p_shop_id: input.shopId,
      p_base_version_id: input.baseVersionId,
      p_result_version_id: input.resultVersionId,
      p_expected_draft_version_id: input.expectedDraftVersionId,
      p_actor_id: input.actorId ?? null,
      ...editAuditRpcParams(input),
    }, "storefront_edit_failed");
  } catch (error) {
    if (!(error instanceof StorefrontReleaseError)
      || error.code !== "storefront_edit_failed"
      || error.message !== "upstream request timeout") throw error;
    const release = await getSupabase()
      .from("storefront_release")
      .select("draft_version_id")
      .eq("shop_id", input.shopId)
      .maybeSingle();
    if (!release.error && release.data?.draft_version_id === input.resultVersionId) return input.resultVersionId;
    throw error;
  }
}

export interface PublishStorefrontReleaseInput {
  shopId: string;
  expectedDraftVersionId: string;
  expectedPublishedVersionId: string | null;
  actorId?: string | null;
  signal?: AbortSignal;
}

async function assertDraftPassesCurrentValidation(shopId: string, versionId: string, signal?: AbortSignal): Promise<void> {
  let query = getSupabase()
    .from("storefront_bundle_version")
    .select("runtime_version, status, bundle_json")
    .eq("shop_id", shopId)
    .eq("id", versionId);
  if (signal) query = query.abortSignal(signal);
  const result = await query.maybeSingle();
  if (result.error) {
    throw new StorefrontReleaseError(
      "storefront_bundle_revalidation_failed",
      "The storefront draft could not be checked before publishing.",
      500,
      result.error,
    );
  }
  const row = result.data as {
    runtime_version?: unknown;
    status?: unknown;
    bundle_json?: { bundle?: unknown } | null;
  } | null;
  if (!row) {
    throw new StorefrontReleaseError("storefront_publish_conflict", "The storefront draft no longer exists.", 409);
  }
  if (row.runtime_version !== 1) {
    throw new StorefrontReleaseError(
      "storefront_bundle_revalidation_failed",
      "Only runtime-1 storefront drafts can be published.",
      422,
    );
  }
  const report = validateCompiledBundle(row.bundle_json?.bundle);
  if (row.status !== "validated" || !report.ok) {
    throw new StorefrontReleaseError(
      "storefront_bundle_revalidation_failed",
      "This storefront draft was created with an older validation profile. Rebuild it before publishing.",
      422,
      report.diagnostics,
    );
  }
}

export async function publishStorefrontRelease(input: PublishStorefrontReleaseInput): Promise<string> {
  throwIfReleaseAborted(input.signal);
  await assertStorefrontWriteAllowed(input.shopId);
  throwIfReleaseAborted(input.signal);
  await assertDraftPassesCurrentValidation(input.shopId, input.expectedDraftVersionId, input.signal);
  throwIfReleaseAborted(input.signal);
  return writeRpc<string>("publish_storefront_runtime1_release", {
    p_shop_id: input.shopId,
    p_expected_draft_version_id: input.expectedDraftVersionId,
    p_expected_published_version_id: input.expectedPublishedVersionId,
    p_actor_id: input.actorId ?? null,
  }, "storefront_publish_failed");
}

export interface RollbackStorefrontReleaseInput {
  shopId: string;
  targetVersionId: string;
  expectedPublishedVersionId: string | null;
  actorId?: string | null;
}

export async function rollbackStorefrontRelease(input: RollbackStorefrontReleaseInput): Promise<string> {
  await assertStorefrontWriteAllowed(input.shopId);
  requireUuid(input.targetVersionId, "targetVersionId");
  return writeRpc<string>("rollback_storefront_release", {
    p_shop_id: input.shopId,
    p_target_version_id: input.targetVersionId,
    p_expected_published_version_id: input.expectedPublishedVersionId,
    p_actor_id: input.actorId ?? null,
  }, "storefront_rollback_failed");
}
