import { createHash, randomUUID } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { CalderynError } from "~/lib/calderyn.server";
import { createAnthropicStructuredProvider } from "../storefront-ai/provider.server";
import type { StorefrontAiProvider } from "../storefront-ai/contracts";
import {
  createStorefrontBundleVersion,
  editStorefrontDraft,
  hashStorefrontArtifact,
  StorefrontReleaseError,
  type CreateStorefrontBundleVersionInput,
  type EditStorefrontDraftInput,
} from "../storefront-bundle/release.server";
import type { StorefrontBundleV1, StorefrontRouteId } from "../storefront-bundle/types";
import { validateCompiledBundle, type BundleValidationReport } from "../storefront-compiler/validate";
import { applyDeterministicStorefrontEdit } from "./deterministic";
import { parseEditIntent } from "./intent";
import { applyStorefrontPatch, StorefrontPatchError } from "./patch.server";
import { STOREFRONT_PATCH_SYSTEM_PROMPT, storefrontPatchPrompt } from "./prompts";
import type {
  CompiledStorefrontPatch,
  LoadedStorefrontDraft,
  PreviewEditContext,
  StorefrontEditReceipt,
  StorefrontPatchOperation,
} from "./types";

export class StorefrontEditError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly details?: unknown) {
    super(message);
    this.name = "StorefrontEditError";
  }
}

export interface StorefrontEditDependencies {
  loadDraft(shopId: string): Promise<LoadedStorefrontDraft | null>;
  loadVersion(shopId: string, versionId: string): Promise<LoadedStorefrontDraft | null>;
  preflight(input: { shopId: string; prompt: string; trusted: boolean }): Promise<void>;
  compileStructuralPatch(input: {
    prompt: string;
    context?: PreviewEditContext;
    bundle: StorefrontBundleV1;
  }): Promise<CompiledStorefrontPatch>;
  validate(bundle: StorefrontBundleV1): BundleValidationReport;
  createVersion(input: CreateStorefrontBundleVersionInput): Promise<string>;
  hashArtifact(input: {
    schemaVersion: number;
    runtimeVersion: number;
    validationProfileVersion: number;
    artifact: Record<string, unknown>;
    assetManifest: Record<string, unknown>;
  }): Promise<string>;
  editDraft(input: EditStorefrontDraftInput): Promise<string>;
  randomId(): string;
}

function isBundle(value: unknown): value is StorefrontBundleV1 {
  return Boolean(value) && typeof value === "object" && (value as StorefrontBundleV1).runtimeVersion === 1;
}

function extractBundle(artifact: unknown): StorefrontBundleV1 | null {
  if (!artifact || typeof artifact !== "object") return null;
  const record = artifact as Record<string, unknown>;
  if (isBundle(record.bundle)) return record.bundle;
  return isBundle(artifact) ? artifact : null;
}

async function loadVersion(shopId: string, versionId?: string): Promise<LoadedStorefrontDraft | null> {
  let query = getSupabase()
    .from("storefront_bundle_version")
    .select("id, artifact_hash, bundle_json, runtime_version, status")
    .eq("shop_id", shopId);
  if (versionId) query = query.eq("id", versionId);
  const result = await query.maybeSingle();
  if (result.error) throw result.error;
  const row = result.data as Record<string, unknown> | null;
  const bundle = extractBundle(row?.bundle_json);
  if (!row || row.status !== "validated" || Number(row.runtime_version) !== 1 || !bundle) return null;
  return { versionId: String(row.id), artifactHash: String(row.artifact_hash), bundle };
}

async function loadDraft(shopId: string): Promise<LoadedStorefrontDraft | null> {
  const release = await getSupabase().from("storefront_release").select("draft_version_id").eq("shop_id", shopId).maybeSingle();
  if (release.error) throw release.error;
  const id = release.data?.draft_version_id;
  return typeof id === "string" ? loadVersion(shopId, id) : null;
}

const PATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array", minItems: 1, maxItems: 8,
      items: {
        oneOf: [
          {
            type: "object", additionalProperties: false,
            required: ["kind", "routeId", "targetId", "value"],
            properties: {
              kind: { const: "replaceTextChildren" }, routeId: { enum: ["home", "collection", "product", "search", "cart", "checkout"] },
              targetId: { type: "string", maxLength: 120 }, value: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
          {
            type: "object", additionalProperties: false,
            required: ["kind", "routeId", "targetId", "hidden"],
            properties: {
              kind: { const: "setVisibility" }, routeId: { enum: ["home", "collection", "product", "search", "cart", "checkout"] },
              targetId: { type: "string", maxLength: 120 }, hidden: { type: "boolean" },
            },
          },
        ],
      },
    },
  },
};

function parseProviderOperations(value: unknown, context?: PreviewEditContext): StorefrontPatchOperation[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { operations?: unknown }).operations)) {
    throw new StorefrontEditError("storefront_patch_invalid", "The patch compiler returned an invalid operation list.", 502);
  }
  const operations = (value as { operations: unknown[] }).operations;
  if (operations.length < 1 || operations.length > 8) throw new StorefrontEditError("storefront_patch_invalid", "The patch compiler returned too many operations.", 502);
  return operations.map((candidate): StorefrontPatchOperation => {
    if (!candidate || typeof candidate !== "object") throw new StorefrontEditError("storefront_patch_invalid", "A patch operation was malformed.", 502);
    const op = candidate as Record<string, unknown>;
    if (!new Set(["home", "collection", "product", "search", "cart", "checkout"]).has(String(op.routeId))) {
      throw new StorefrontEditError("storefront_patch_invalid", "A patch route was not allowed.", 502);
    }
    const routeId = op.routeId as StorefrontRouteId;
    if (context && (routeId !== context.routeId || op.targetId !== context.regionId)) {
      throw new StorefrontEditError("storefront_patch_scope", "The patch compiler attempted to edit outside the selected preview region.", 502);
    }
    if (op.kind === "replaceTextChildren" && typeof op.targetId === "string" && typeof op.value === "string") {
      return { kind: "replaceTextChildren", routeId, targetId: op.targetId, value: op.value };
    }
    if (op.kind === "setVisibility" && typeof op.targetId === "string" && typeof op.hidden === "boolean") {
      return { kind: "setVisibility", routeId, targetId: op.targetId, hidden: op.hidden };
    }
    throw new StorefrontEditError("storefront_patch_invalid", "A patch operation kind was not allowed.", 502);
  });
}

export function createDefaultStructuralPatchCompiler(provider?: StorefrontAiProvider) {
  return async (input: { prompt: string; context?: PreviewEditContext; bundle: StorefrontBundleV1 }): Promise<CompiledStorefrontPatch> => {
    const response = await (provider ?? createAnthropicStructuredProvider()).complete({
      operation: "patch",
      system: STOREFRONT_PATCH_SYSTEM_PROMPT,
      prompt: storefrontPatchPrompt(input),
      schema: PATCH_SCHEMA,
    });
    return {
      operations: parseProviderOperations(response.value, input.context),
      provider: { kind: "ai_patch", provider: response.provider, model: response.model, usage: response.usage },
    };
  };
}

const defaultDependencies: StorefrontEditDependencies = {
  loadDraft,
  loadVersion,
  preflight: ({ shopId, prompt, trusted }) => assertCanGenerate(shopId, prompt, { trusted }),
  compileStructuralPatch: (input) => createDefaultStructuralPatchCompiler()(input),
  validate: validateCompiledBundle,
  createVersion: createStorefrontBundleVersion,
  hashArtifact: hashStorefrontArtifact,
  editDraft: editStorefrontDraft,
  randomId: randomUUID,
};

function promptHash(prompt: string): string {
  return `sha256:${createHash("sha256").update(prompt.trim()).digest("hex")}`;
}

function auditJson(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function recipeFields(bundle: StorefrontBundleV1) {
  return bundle.source.kind === "recipe"
    ? { sourceKind: "recipe" as const, templateId: bundle.source.templateId, templateVersion: bundle.source.templateVersion }
    : { sourceKind: "custom" as const, templateId: null, templateVersion: null };
}

function mapError(error: unknown): never {
  if (error instanceof StorefrontEditError) throw error;
  if (error instanceof StorefrontPatchError) throw new StorefrontEditError(error.code, error.message, 422, error);
  if (error instanceof StorefrontReleaseError) throw new StorefrontEditError(error.code, error.message, error.status, error);
  if (error instanceof CalderynError) throw new StorefrontEditError(error.code, error.message, error.status, error.details);
  throw error;
}

export async function editStorefrontByPrompt(
  input: {
    shopId: string;
    actorId?: string | null;
    prompt: string;
    expectedDraftVersionId: string;
    context?: PreviewEditContext;
    trusted?: boolean;
  },
  dependencies: StorefrontEditDependencies = defaultDependencies,
): Promise<StorefrontEditReceipt | { status: "start_over" }> {
  const intent = parseEditIntent(input.prompt, input.context);
  if (intent.kind === "startOver") return { status: "start_over" };
  try {
    const base = await dependencies.loadDraft(input.shopId);
    if (!base) throw new StorefrontEditError("storefront_edit_unavailable", "There is no runtime-1 draft to edit.", 409);
    if (base.versionId !== input.expectedDraftVersionId) {
      throw new StorefrontEditError("storefront_edit_conflict", "The storefront draft changed before this edit.", 409);
    }

    const compiledPatch = intent.kind === "deterministic"
      ? { operations: intent.operations, provider: { kind: "deterministic" as const, model: null } }
      : await (async () => {
          await dependencies.preflight({ shopId: input.shopId, prompt: input.prompt, trusted: input.trusted ?? false });
          return dependencies.compileStructuralPatch({ prompt: input.prompt, context: intent.context, bundle: base.bundle });
        })();
    const applied = intent.kind === "deterministic"
      ? applyDeterministicStorefrontEdit(base.bundle, compiledPatch.operations)
      : applyStorefrontPatch(base.bundle, compiledPatch.operations);
    if (JSON.stringify(applied.bundle) === JSON.stringify(base.bundle)) {
      throw new StorefrontEditError("storefront_edit_no_change", "That request did not change the storefront.", 422);
    }

    const detached = base.bundle.source.kind === "recipe" && (intent.kind === "structural" || applied.structural);
    if (detached && base.bundle.source.kind === "recipe") {
      applied.bundle.source = {
        kind: "custom",
        generationId: dependencies.randomId(),
        promptHash: promptHash(input.prompt),
        derivedFromVersionId: base.versionId,
        derivedFromTemplateId: base.bundle.source.templateId,
        derivedFromTemplateVersion: base.bundle.source.templateVersion,
      };
    }
    const validation = dependencies.validate(applied.bundle);
    if (!validation.ok) {
      throw new StorefrontEditError("storefront_edit_invalid", "The requested change did not pass storefront validation. Your draft was not changed.", 422, validation.diagnostics);
    }
    const artifact = { sourceKind: applied.bundle.source.kind, bundle: applied.bundle };
    const resultHash = await dependencies.hashArtifact({
      schemaVersion: applied.bundle.schemaVersion,
      runtimeVersion: applied.bundle.runtimeVersion,
      validationProfileVersion: applied.bundle.validationProfileVersion,
      artifact,
      assetManifest: applied.bundle.assets as unknown as Record<string, unknown>,
    });
    const versionId = await dependencies.createVersion({
      shopId: input.shopId,
      ...recipeFields(applied.bundle),
      status: "validated",
      schemaVersion: applied.bundle.schemaVersion,
      runtimeVersion: applied.bundle.runtimeVersion,
      validationProfileVersion: applied.bundle.validationProfileVersion,
      artifact,
      assetManifest: applied.bundle.assets as unknown as Record<string, unknown>,
      validationReport: validation as unknown as Record<string, unknown>,
      generationPrompt: input.prompt,
      resolution: { kind: "edit", baseVersionId: base.versionId, detachedFromRecipe: detached },
    });
    await dependencies.editDraft({
      shopId: input.shopId,
      baseVersionId: base.versionId,
      resultVersionId: versionId,
      expectedDraftVersionId: input.expectedDraftVersionId,
      actorId: input.actorId ?? null,
      baseArtifactHash: base.artifactHash,
      resultArtifactHash: resultHash,
      prompt: input.prompt,
      scope: auditJson(applied.changedScope),
      patch: { operations: compiledPatch.operations },
      provider: auditJson(compiledPatch.provider),
      validation: auditJson(validation),
    });
    return {
      status: "installed",
      versionId,
      baseVersionId: base.versionId,
      bundle: applied.bundle,
      changedScope: applied.changedScope,
      detachedFromRecipe: detached,
      undo: { targetVersionId: base.versionId, expectedDraftVersionId: versionId },
    };
  } catch (error) {
    mapError(error);
  }
}

export async function undoStorefrontEdit(
  input: { shopId: string; actorId?: string | null; expectedDraftVersionId: string; targetVersionId: string },
  dependencies: StorefrontEditDependencies = defaultDependencies,
): Promise<{ status: "installed"; versionId: string; undoneVersionId: string }> {
  try {
    const [current, target] = await Promise.all([
      dependencies.loadDraft(input.shopId),
      dependencies.loadVersion(input.shopId, input.targetVersionId),
    ]);
    if (!current || current.versionId !== input.expectedDraftVersionId) {
      throw new StorefrontEditError("storefront_edit_conflict", "The storefront draft changed before undo.", 409);
    }
    if (!target) throw new StorefrontEditError("storefront_undo_target_missing", "The undo version is no longer available.", 409);
    await dependencies.editDraft({
      shopId: input.shopId,
      baseVersionId: current.versionId,
      resultVersionId: target.versionId,
      expectedDraftVersionId: input.expectedDraftVersionId,
      actorId: input.actorId ?? null,
      baseArtifactHash: current.artifactHash,
      resultArtifactHash: target.artifactHash,
      prompt: "Undo storefront edit",
      scope: { kind: "undo", restoredVersionId: target.versionId },
      patch: { operations: [{ kind: "restoreVersion", versionId: target.versionId }] },
      provider: { kind: "deterministic", model: null },
      validation: { reusedValidatedVersion: true },
    });
    return { status: "installed", versionId: target.versionId, undoneVersionId: current.versionId };
  } catch (error) {
    mapError(error);
  }
}
