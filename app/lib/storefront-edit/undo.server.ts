import { getSupabase } from "~/lib/supabase.server";
import type { BrowserProofReport, MerchantStorefrontContext } from "~/lib/storefront-ai/contracts";
import {
  createStorefrontBundleVersion,
  editStorefrontDraft,
  hashStorefrontArtifact,
  StorefrontReleaseError,
  type CreateStorefrontBundleVersionInput,
  type EditStorefrontDraftInput,
  type HashStorefrontArtifactInput,
} from "~/lib/storefront-bundle/release.server";
import { isStoreTemplateId } from "~/lib/storefront-bundle/registry";
import type { StorefrontBundleV1 } from "~/lib/storefront-bundle/types";
import { validateCompiledBundle, type BundleValidationReport } from "~/lib/storefront-compiler/validate";
import {
  assembleStorefrontContextWithReferences,
  type StorefrontContextAssembly,
} from "~/lib/storefront-ai/context.server";
import { storefrontAiBrowserProof } from "~/lib/storefront-validation/browser.server";

interface LoadedStorefrontVersion {
  versionId: string;
  artifactHash: string;
  bundle: StorefrontBundleV1;
  resolution: Record<string, unknown>;
}

export class StorefrontUndoError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly details?: unknown) {
    super(message);
    this.name = "StorefrontUndoError";
  }
}

export interface StorefrontUndoDependencies {
  loadDraft(shopId: string): Promise<LoadedStorefrontVersion | null>;
  loadVersion(shopId: string, versionId: string): Promise<LoadedStorefrontVersion | null>;
  loadEditAudit(input: { shopId: string; resultVersionId: string }): Promise<{ baseVersionId: string; resultVersionId: string } | null>;
  validate(bundle: StorefrontBundleV1): BundleValidationReport;
  loadProofContext(input: { shopId: string; prompt: string }): Promise<StorefrontContextAssembly>;
  prove(input: { bundle: StorefrontBundleV1; context: MerchantStorefrontContext; persistedAssets: []; signal?: AbortSignal }): Promise<BrowserProofReport>;
  hashArtifact(input: HashStorefrontArtifactInput): Promise<string>;
  createVersion(input: CreateStorefrontBundleVersionInput): Promise<string>;
  editDraft(input: EditStorefrontDraftInput): Promise<string>;
}

function extractBundle(value: unknown): StorefrontBundleV1 | null {
  if (!value || typeof value !== "object") return null;
  const artifact = value as Record<string, unknown>;
  const candidate = artifact.bundle ?? value;
  return candidate && typeof candidate === "object" && (candidate as StorefrontBundleV1).runtimeVersion === 1
    ? candidate as StorefrontBundleV1
    : null;
}

async function loadVersion(shopId: string, versionId: string): Promise<LoadedStorefrontVersion | null> {
  const result = await getSupabase()
    .from("storefront_bundle_version")
    .select("id, artifact_hash, bundle_json, resolution_json, runtime_version, status")
    .eq("shop_id", shopId)
    .eq("id", versionId)
    .maybeSingle();
  if (result.error) throw result.error;
  const row = result.data as Record<string, unknown> | null;
  const bundle = extractBundle(row?.bundle_json);
  if (!row || row.status !== "validated" || Number(row.runtime_version) !== 1 || !bundle) return null;
  const resolution = row.resolution_json && typeof row.resolution_json === "object" && !Array.isArray(row.resolution_json)
    ? row.resolution_json as Record<string, unknown>
    : {};
  return { versionId: String(row.id), artifactHash: String(row.artifact_hash), bundle, resolution };
}

async function loadDraft(shopId: string): Promise<LoadedStorefrontVersion | null> {
  const result = await getSupabase()
    .from("storefront_release")
    .select("draft_version_id")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (result.error) throw result.error;
  return typeof result.data?.draft_version_id === "string"
    ? loadVersion(shopId, result.data.draft_version_id)
    : null;
}

async function loadEditAudit(input: { shopId: string; resultVersionId: string }) {
  const result = await getSupabase()
    .from("storefront_bundle_edit")
    .select("base_version_id, result_version_id")
    .eq("shop_id", input.shopId)
    .eq("result_version_id", input.resultVersionId)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data
    ? { baseVersionId: String(result.data.base_version_id), resultVersionId: String(result.data.result_version_id) }
    : null;
}

const defaultDependencies: StorefrontUndoDependencies = {
  loadDraft,
  loadVersion,
  loadEditAudit,
  validate: validateCompiledBundle,
  loadProofContext: assembleStorefrontContextWithReferences,
  prove: storefrontAiBrowserProof,
  hashArtifact: hashStorefrontArtifact,
  createVersion: createStorefrontBundleVersion,
  editDraft: editStorefrontDraft,
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new StorefrontUndoError("storefront_edit_cancelled", "Storefront generation was stopped. Your draft was not changed.", 409);
  }
}

function exclusions(version: LoadedStorefrontVersion): string[] {
  const value = version.resolution.excludedTemplateIds;
  return Array.isArray(value) ? [...new Set(value.filter(isStoreTemplateId))] : [];
}

function ownedProofContext(assembly: StorefrontContextAssembly, featuredProductIds: string[]): MerchantStorefrontContext {
  const products = assembly.context.products.map((product) => {
    const owned = assembly.references.products[product.id];
    if (!owned) {
      throw new StorefrontUndoError("storefront_command_invalid", "That product selection could not be resolved safely.", 422);
    }
    return { ...product, id: owned.id };
  });
  const availableIds = new Set(products.map(({ id }) => id));
  if (featuredProductIds.some((id) => !availableIds.has(id))) {
    throw new StorefrontUndoError("storefront_command_invalid", "That product selection could not be resolved safely.", 422);
  }
  return { ...assembly.context, products };
}

function mapError(error: unknown): never {
  if (error instanceof StorefrontUndoError) throw error;
  if (error instanceof StorefrontReleaseError) {
    throw new StorefrontUndoError(error.code, error.message, error.status, error);
  }
  throw error;
}

export async function undoStorefrontEdit(
  input: { shopId: string; actorId?: string | null; expectedDraftVersionId: string; targetVersionId: string; signal?: AbortSignal },
  dependencies: StorefrontUndoDependencies = defaultDependencies,
): Promise<{ status: "installed"; versionId: string; undoneVersionId: string }> {
  let terminalDispatched = false;
  try {
    throwIfAborted(input.signal);
    const current = await dependencies.loadDraft(input.shopId);
    throwIfAborted(input.signal);
    if (!current || current.versionId !== input.expectedDraftVersionId) {
      throw new StorefrontUndoError("storefront_edit_conflict", "The storefront draft changed before undo.", 409);
    }
    const audit = await dependencies.loadEditAudit({ shopId: input.shopId, resultVersionId: current.versionId });
    throwIfAborted(input.signal);
    if (!audit || audit.resultVersionId !== current.versionId || audit.baseVersionId !== input.targetVersionId) {
      throw new StorefrontUndoError("storefront_undo_target_invalid", "The requested version is not the recorded base of the current storefront edit.", 409);
    }
    const target = await dependencies.loadVersion(input.shopId, input.targetVersionId);
    throwIfAborted(input.signal);
    if (!target) throw new StorefrontUndoError("storefront_undo_target_missing", "The undo version is no longer available.", 409);
    if (target.bundle.source.kind !== "recipe") {
      throw new StorefrontUndoError("storefront_command_unavailable", "This storefront version cannot be restored with chat yet.", 503);
    }
    const validation = dependencies.validate(target.bundle);
    if (!validation.ok) {
      throw new StorefrontUndoError("storefront_undo_target_invalid", "The undo version no longer passes storefront validation.", 409, validation.diagnostics);
    }
    const contextAssembly = await dependencies.loadProofContext({ shopId: input.shopId, prompt: "Undo storefront edit" });
    throwIfAborted(input.signal);
    const browserProof = await dependencies.prove({
      bundle: target.bundle,
      context: ownedProofContext(contextAssembly, target.bundle.featuredProductIds ?? []),
      persistedAssets: [],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfAborted(input.signal);
    if (!browserProof.ok) {
      throw new StorefrontUndoError("storefront_edit_browser_proof_failed", "The undo version did not pass preview checks.", 422, browserProof);
    }
    const artifact = { sourceKind: "recipe" as const, bundle: target.bundle };
    const artifactHash = await dependencies.hashArtifact({
      schemaVersion: target.bundle.schemaVersion,
      runtimeVersion: target.bundle.runtimeVersion,
      validationProfileVersion: target.bundle.validationProfileVersion,
      artifact,
      assetManifest: target.bundle.assets as unknown as Record<string, unknown>,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfAborted(input.signal);
    if (artifactHash !== target.artifactHash) {
      throw new StorefrontUndoError("storefront_undo_target_invalid", "The undo version no longer matches its immutable artifact.", 409);
    }
    const versionId = await dependencies.createVersion({
      shopId: input.shopId,
      sourceKind: "recipe",
      templateId: target.bundle.source.templateId,
      templateVersion: target.bundle.source.templateVersion,
      status: "validated",
      schemaVersion: target.bundle.schemaVersion,
      runtimeVersion: target.bundle.runtimeVersion,
      validationProfileVersion: target.bundle.validationProfileVersion,
      artifact,
      assetManifest: target.bundle.assets as unknown as Record<string, unknown>,
      validationReport: { ...validation, valid: true, browserProof },
      generationPrompt: "Undo storefront edit",
      resolution: {
        kind: "undo",
        restoredFromVersionId: target.versionId,
        undoneVersionId: current.versionId,
        excludedTemplateIds: exclusions(target),
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfAborted(input.signal);
    terminalDispatched = true;
    await dependencies.editDraft({
      shopId: input.shopId,
      baseVersionId: current.versionId,
      resultVersionId: versionId,
      expectedDraftVersionId: input.expectedDraftVersionId,
      actorId: input.actorId ?? null,
      baseArtifactHash: current.artifactHash,
      resultArtifactHash: artifactHash,
      prompt: "Undo storefront edit",
      scope: { kind: "undo", restoredVersionId: target.versionId },
      patch: { operations: [{ kind: "restoreVersion", versionId: target.versionId }] },
      provider: { kind: "deterministic", model: null },
      validation: { static: validation, browserProof },
    });
    return { status: "installed", versionId, undoneVersionId: current.versionId };
  } catch (error) {
    if (!terminalDispatched && input.signal?.aborted) throwIfAborted(input.signal);
    mapError(error);
  }
}
