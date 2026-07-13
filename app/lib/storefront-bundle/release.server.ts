import { hasRunningExperiment } from "~/lib/experiments/store-experiment.server";
import { isUuid } from "~/lib/ids";
import { getSupabase } from "~/lib/supabase.server";
import { editAuditRpcParams, type StorefrontEditAuditInput } from "./edit-audit.server";

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

async function writeRpc<T>(name: string, params: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await getSupabase().rpc(name, params);
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
}

export async function createStorefrontBundleVersion(input: CreateStorefrontBundleVersionInput): Promise<string> {
  if (input.sourceKind === "legacy") {
    throw new StorefrontReleaseError(
      "legacy_source_requires_capture",
      "Legacy versions can only be created by the validated capture path.",
      422,
    );
  }
  await assertStorefrontWriteAllowed(input.shopId);
  const artifactHash = await hashStorefrontArtifact({
    schemaVersion: input.schemaVersion,
    runtimeVersion: input.runtimeVersion,
    validationProfileVersion: input.validationProfileVersion,
    artifact: input.artifact,
    assetManifest: input.assetManifest,
  });
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
  }, "storefront_bundle_create_failed");
  requireUuid(id, "bundleVersionId");
  return id;
}

export interface HashStorefrontArtifactInput {
  schemaVersion: number;
  runtimeVersion: number;
  validationProfileVersion: number;
  artifact: Record<string, unknown>;
  assetManifest: Record<string, unknown>;
}

export async function hashStorefrontArtifact(input: HashStorefrontArtifactInput): Promise<string> {
  const hash = await writeRpc<string>("hash_storefront_artifact", {
    p_schema_version: input.schemaVersion,
    p_runtime_version: input.runtimeVersion,
    p_validation_profile_version: input.validationProfileVersion,
    p_bundle_json: input.artifact,
    p_asset_manifest: input.assetManifest,
  }, "storefront_artifact_hash_failed");
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
}

export async function installStorefrontDraft(input: InstallStorefrontDraftInput): Promise<string> {
  await assertStorefrontWriteAllowed(input.shopId);
  requireUuid(input.versionId, "versionId");
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
}

export async function editStorefrontDraft(input: EditStorefrontDraftInput): Promise<string> {
  await assertStorefrontWriteAllowed(input.shopId);
  requireUuid(input.baseVersionId, "baseVersionId");
  requireUuid(input.resultVersionId, "resultVersionId");
  return writeRpc<string>("edit_storefront_draft", {
    p_shop_id: input.shopId,
    p_base_version_id: input.baseVersionId,
    p_result_version_id: input.resultVersionId,
    p_expected_draft_version_id: input.expectedDraftVersionId,
    p_actor_id: input.actorId ?? null,
    ...editAuditRpcParams(input),
  }, "storefront_edit_failed");
}

export interface PublishStorefrontReleaseInput {
  shopId: string;
  expectedDraftVersionId: string;
  expectedPublishedVersionId: string | null;
  actorId?: string | null;
}

export async function publishStorefrontRelease(input: PublishStorefrontReleaseInput): Promise<string> {
  await assertStorefrontWriteAllowed(input.shopId);
  const legacyPayload = input.expectedPublishedVersionId === null
    ? await (await import("./legacy.server")).prepareLegacyCapturePayload(input.shopId)
    : null;
  return writeRpc<string>("publish_storefront_release", {
    p_shop_id: input.shopId,
    p_expected_draft_version_id: input.expectedDraftVersionId,
    p_expected_published_version_id: input.expectedPublishedVersionId,
    p_actor_id: input.actorId ?? null,
    p_legacy_snapshot: legacyPayload?.snapshot ?? null,
    p_legacy_asset_manifest: legacyPayload?.assetManifest ?? null,
    p_legacy_artifact_hash: legacyPayload?.artifactHash ?? null,
    p_legacy_validation_report: legacyPayload?.validationReport ?? null,
    p_legacy_capture_token: legacyPayload?.captureToken ?? null,
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
