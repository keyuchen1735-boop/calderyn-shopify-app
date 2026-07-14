import { createHash, randomUUID } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { CalderynError } from "~/lib/calderyn.server";
import { cloneStorefrontBundleAssetProvenance, loadVerifiedStorefrontAssetProofBytes } from "../storefront-bundle/assets.server";
import { createAnthropicStructuredProvider } from "../storefront-ai/provider.server";
import type { BrowserProofReport, MaterializedAssetResult, MerchantStorefrontContext, StorefrontAiProvider } from "../storefront-ai/contracts";
import { assembleStorefrontContext } from "../storefront-ai/context.server";
import {
  createStorefrontBundleVersion,
  editStorefrontDraft,
  hashStorefrontArtifact,
  StorefrontReleaseError,
  validateStorefrontBundleVersion,
  type CreateStorefrontBundleVersionInput,
  type EditStorefrontDraftInput,
  type ValidateStorefrontBundleVersionInput,
} from "../storefront-bundle/release.server";
import type { StorefrontBundleV1, StorefrontRouteId } from "../storefront-bundle/types";
import { validateCompiledBundle, type BundleValidationReport } from "../storefront-compiler/validate";
import { storefrontAiBrowserProof } from "../storefront-validation/browser.server";
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
    repair?: { attempt: 1; staticDiagnostics?: BundleValidationReport["diagnostics"]; browserProof?: BrowserProofReport };
  }): Promise<CompiledStorefrontPatch>;
  validate(bundle: StorefrontBundleV1): BundleValidationReport;
  loadProofContext(input: { shopId: string; prompt: string }): Promise<MerchantStorefrontContext>;
  loadProofAssets(input: {
    shopId: string;
    versionId: string;
    manifest: StorefrontBundleV1["assets"];
  }): Promise<MaterializedAssetResult["proofAssets"]>;
  /** Mandatory production Chromium proof. This must run before any immutable version is created. */
  prove(input: {
    bundle: StorefrontBundleV1;
    context: MerchantStorefrontContext;
    persistedAssets: MaterializedAssetResult["proofAssets"];
  }): Promise<BrowserProofReport>;
  createVersion(input: CreateStorefrontBundleVersionInput): Promise<string>;
  cloneAssetProvenance(input: { shopId: string; sourceVersionId: string; targetVersionId: string }): Promise<void>;
  validateVersion(input: ValidateStorefrontBundleVersionInput): Promise<string>;
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
      type: "array", minItems: 1, maxItems: 12,
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
          {
            type: "object", additionalProperties: false,
            required: ["kind", "routeId", "targetId", "expected", "source"],
            properties: {
              kind: { const: "replaceRegion" }, routeId: { enum: ["home", "collection", "product", "search", "cart"] },
              targetId: { type: "string", minLength: 1, maxLength: 120 },
              expected: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
              source: {
                type: "object", additionalProperties: false, required: ["html", "css"],
                properties: {
                  html: { type: "string", minLength: 1, maxLength: 120000 },
                  css: { type: "string", maxLength: 120000 },
                },
              },
            },
          },
          {
            type: "object", additionalProperties: false,
            required: ["kind", "routeId", "expected", "css"],
            properties: {
              kind: { const: "replaceRouteCss" }, routeId: { enum: ["home", "collection", "product", "search", "cart"] },
              expected: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
              css: { type: "string", maxLength: 120000 },
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
  if (operations.length < 1 || operations.length > 12) throw new StorefrontEditError("storefront_patch_invalid", "The patch compiler returned too many operations.", 502);
  return operations.map((candidate): StorefrontPatchOperation => {
    if (!candidate || typeof candidate !== "object") throw new StorefrontEditError("storefront_patch_invalid", "A patch operation was malformed.", 502);
    const op = candidate as Record<string, unknown>;
    if (!new Set(["home", "collection", "product", "search", "cart", "checkout"]).has(String(op.routeId))) {
      throw new StorefrontEditError("storefront_patch_invalid", "A patch route was not allowed.", 502);
    }
    const routeId = op.routeId as StorefrontRouteId;
    if (context && (routeId !== context.routeId || (op.kind !== "replaceRouteCss" && op.targetId !== context.regionId))) {
      throw new StorefrontEditError("storefront_patch_scope", "The patch compiler attempted to edit outside the selected preview region.", 502);
    }
    if (op.kind === "replaceTextChildren" && typeof op.targetId === "string" && typeof op.value === "string") {
      return { kind: "replaceTextChildren", routeId, targetId: op.targetId, value: op.value };
    }
    if (op.kind === "setVisibility" && typeof op.targetId === "string" && typeof op.hidden === "boolean") {
      return { kind: "setVisibility", routeId, targetId: op.targetId, hidden: op.hidden };
    }
    if (op.kind === "replaceRegion" && routeId !== "checkout" && typeof op.targetId === "string" &&
        typeof op.expected === "string" && /^sha256:[a-f0-9]{64}$/.test(op.expected) &&
        op.source && typeof op.source === "object" && !Array.isArray(op.source)) {
      const source = op.source as Record<string, unknown>;
      if (Object.keys(source).some((key) => key !== "html" && key !== "css") ||
          typeof source.html !== "string" || source.html.length < 1 || source.html.length > 120_000 ||
          typeof source.css !== "string" || source.css.length > 120_000) {
        throw new StorefrontEditError("storefront_patch_invalid", "Replacement compiler source was malformed.", 502);
      }
      return { kind: "replaceRegion", routeId, targetId: op.targetId, expected: op.expected, source: { html: source.html, css: source.css } };
    }
    if (op.kind === "replaceRouteCss" && routeId !== "checkout" && typeof op.expected === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(op.expected) && typeof op.css === "string" && op.css.length <= 120_000) {
      return { kind: "replaceRouteCss", routeId, expected: op.expected, css: op.css };
    }
    throw new StorefrontEditError("storefront_patch_invalid", "A patch operation kind was not allowed.", 502);
  });
}

export function createDefaultStructuralPatchCompiler(provider?: StorefrontAiProvider) {
  return async (input: {
    prompt: string;
    context?: PreviewEditContext;
    bundle: StorefrontBundleV1;
    repair?: { attempt: 1; staticDiagnostics?: BundleValidationReport["diagnostics"]; browserProof?: BrowserProofReport };
  }): Promise<CompiledStorefrontPatch> => {
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
  loadProofContext: ({ shopId, prompt }) => assembleStorefrontContext({ shopId, prompt }),
  loadProofAssets: ({ shopId, versionId, manifest }) => loadVerifiedStorefrontAssetProofBytes({ shopId, bundleId: versionId, manifest }),
  prove: ({ bundle, context, persistedAssets }) => storefrontAiBrowserProof({ bundle, context, persistedAssets }),
  createVersion: createStorefrontBundleVersion,
  cloneAssetProvenance: cloneStorefrontBundleAssetProvenance,
  validateVersion: validateStorefrontBundleVersion,
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

function databaseValidationReport(validation: BundleValidationReport): Record<string, unknown> {
  return { ...validation, valid: validation.ok } as unknown as Record<string, unknown>;
}

async function proveEditBundle(
  bundle: StorefrontBundleV1,
  context: MerchantStorefrontContext,
  persistedAssets: MaterializedAssetResult["proofAssets"],
  dependencies: StorefrontEditDependencies,
): Promise<BrowserProofReport> {
  try {
    const report = await dependencies.prove({ bundle, context, persistedAssets });
    if (!report.ok) {
      throw new StorefrontEditError(
        "storefront_edit_browser_proof_failed",
        "The requested change did not pass browser proof. Your draft was not changed.",
        422,
        report,
      );
    }
    return report;
  } catch (error) {
    if (error instanceof StorefrontEditError) throw error;
    const report = error && typeof error === "object" && "report" in error
      ? (error as { report?: unknown }).report
      : undefined;
    throw new StorefrontEditError(
      "storefront_edit_browser_proof_failed",
      "The requested change did not pass browser proof. Your draft was not changed.",
      422,
      report,
    );
  }
}

function needsOwnedProofAssets(bundle: StorefrontBundleV1): boolean {
  return bundle.source.kind === "custom" && bundle.source.derivedFromTemplateId === undefined && bundle.assets.entries.length > 0;
}

async function createValidatedEditVersion(input: {
  shopId: string;
  sourceVersionId: string;
  bundle: StorefrontBundleV1;
  artifact: Record<string, unknown>;
  artifactHash: string;
  validation: BundleValidationReport;
  generationPrompt: string;
  resolution: Record<string, unknown>;
}, dependencies: StorefrontEditDependencies): Promise<string> {
  const custom = input.bundle.source.kind === "custom";
  const validationReport = databaseValidationReport(input.validation);
  const versionId = await dependencies.createVersion({
    shopId: input.shopId,
    ...recipeFields(input.bundle),
    status: custom ? "candidate" : "validated",
    schemaVersion: input.bundle.schemaVersion,
    runtimeVersion: input.bundle.runtimeVersion,
    validationProfileVersion: input.bundle.validationProfileVersion,
    artifact: input.artifact,
    assetManifest: input.bundle.assets as unknown as Record<string, unknown>,
    validationReport: custom ? null : validationReport,
    generationPrompt: input.generationPrompt,
    resolution: input.resolution,
  });
  if (custom) {
    await dependencies.cloneAssetProvenance({
      shopId: input.shopId,
      sourceVersionId: input.sourceVersionId,
      targetVersionId: versionId,
    });
    await dependencies.validateVersion({
      shopId: input.shopId,
      versionId,
      artifactHash: input.artifactHash,
      validationReport,
    });
  }
  return versionId;
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
    let compiledPatch = intent.kind === "deterministic"
      ? { operations: intent.operations, provider: { kind: "deterministic" as const, model: null } }
      : await (async () => {
          await dependencies.preflight({ shopId: input.shopId, prompt: input.prompt, trusted: input.trusted ?? false });
          return dependencies.compileStructuralPatch({ prompt: input.prompt, context: intent.context, bundle: base.bundle });
        })();
    let applied: ReturnType<typeof applyStorefrontPatch>;
    let validation: BundleValidationReport;
    let browserProof: BrowserProofReport;
    let proofContext: MerchantStorefrontContext | null = null;
    let proofAssets: MaterializedAssetResult["proofAssets"] | null = null;
    let repairAttempted = false;
    for (;;) {
      applied = intent.kind === "deterministic"
        ? applyDeterministicStorefrontEdit(base.bundle, compiledPatch.operations)
        : applyStorefrontPatch(base.bundle, compiledPatch.operations);
      if (JSON.stringify(applied.bundle) === JSON.stringify(base.bundle)) {
        throw new StorefrontEditError("storefront_edit_no_change", "That request did not change the storefront.", 422);
      }
      const shouldDetach = base.bundle.source.kind === "recipe" && (intent.kind === "structural" || applied.structural);
      if (shouldDetach && base.bundle.source.kind === "recipe") {
        applied.bundle.source = {
          kind: "custom",
          generationId: dependencies.randomId(),
          promptHash: promptHash(input.prompt),
          derivedFromVersionId: base.versionId,
          derivedFromTemplateId: base.bundle.source.templateId,
          derivedFromTemplateVersion: base.bundle.source.templateVersion,
        };
      }
      validation = dependencies.validate(applied.bundle);
      if (!validation.ok) {
        if (intent.kind === "structural" && !repairAttempted) {
          repairAttempted = true;
          compiledPatch = await dependencies.compileStructuralPatch({
            prompt: input.prompt,
            context: intent.context,
            bundle: base.bundle,
            repair: { attempt: 1, staticDiagnostics: validation.diagnostics },
          });
          continue;
        }
        throw new StorefrontEditError("storefront_edit_invalid", "The requested change did not pass storefront validation. Your draft was not changed.", 422, validation.diagnostics);
      }
      try {
        proofContext ??= await dependencies.loadProofContext({ shopId: input.shopId, prompt: input.prompt });
        proofAssets ??= needsOwnedProofAssets(base.bundle)
          ? await dependencies.loadProofAssets({ shopId: input.shopId, versionId: base.versionId, manifest: base.bundle.assets })
          : [];
        browserProof = await proveEditBundle(applied.bundle, proofContext, proofAssets, dependencies);
        break;
      } catch (error) {
        const failedProof = error instanceof StorefrontEditError && error.details && typeof error.details === "object" &&
          "ok" in error.details && (error.details as BrowserProofReport).ok === false
          ? error.details as BrowserProofReport
          : null;
        if (intent.kind === "structural" && !repairAttempted && failedProof) {
          repairAttempted = true;
          compiledPatch = await dependencies.compileStructuralPatch({
            prompt: input.prompt,
            context: intent.context,
            bundle: base.bundle,
            repair: { attempt: 1, browserProof: failedProof },
          });
          continue;
        }
        throw error;
      }
    }
    const detached = base.bundle.source.kind === "recipe" && (intent.kind === "structural" || applied.structural);
    const artifact = { sourceKind: applied.bundle.source.kind, bundle: applied.bundle };
    const resultHash = await dependencies.hashArtifact({
      schemaVersion: applied.bundle.schemaVersion,
      runtimeVersion: applied.bundle.runtimeVersion,
      validationProfileVersion: applied.bundle.validationProfileVersion,
      artifact,
      assetManifest: applied.bundle.assets as unknown as Record<string, unknown>,
    });
    const versionId = await createValidatedEditVersion({
      shopId: input.shopId,
      sourceVersionId: base.versionId,
      bundle: applied.bundle,
      artifact,
      artifactHash: resultHash,
      validation,
      generationPrompt: input.prompt,
      resolution: { kind: "edit", baseVersionId: base.versionId, detachedFromRecipe: detached },
    }, dependencies);
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
      validation: auditJson({ static: validation, browserProof }),
    });
    return {
      status: "installed",
      versionId,
      baseVersionId: base.versionId,
      bundle: applied.bundle,
      changedScope: applied.changedScope,
      browserProof,
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
    const validation = dependencies.validate(target.bundle);
    if (!validation.ok) {
      throw new StorefrontEditError(
        "storefront_undo_target_invalid",
        "The undo version no longer passes storefront validation.",
        409,
        validation.diagnostics,
      );
    }
    const proofContext = await dependencies.loadProofContext({ shopId: input.shopId, prompt: "Undo storefront edit" });
    const proofAssets = needsOwnedProofAssets(target.bundle)
      ? await dependencies.loadProofAssets({ shopId: input.shopId, versionId: target.versionId, manifest: target.bundle.assets })
      : [];
    const browserProof = await proveEditBundle(target.bundle, proofContext, proofAssets, dependencies);
    const artifact = { sourceKind: target.bundle.source.kind, bundle: target.bundle };
    const resultHash = await dependencies.hashArtifact({
      schemaVersion: target.bundle.schemaVersion,
      runtimeVersion: target.bundle.runtimeVersion,
      validationProfileVersion: target.bundle.validationProfileVersion,
      artifact,
      assetManifest: target.bundle.assets as unknown as Record<string, unknown>,
    });
    const restoredVersionId = await createValidatedEditVersion({
      shopId: input.shopId,
      sourceVersionId: target.versionId,
      bundle: target.bundle,
      artifact,
      artifactHash: resultHash,
      validation,
      generationPrompt: "Undo storefront edit",
      resolution: { kind: "undo", restoredFromVersionId: target.versionId, undoneVersionId: current.versionId },
    }, dependencies);
    await dependencies.editDraft({
      shopId: input.shopId,
      baseVersionId: current.versionId,
      resultVersionId: restoredVersionId,
      expectedDraftVersionId: input.expectedDraftVersionId,
      actorId: input.actorId ?? null,
      baseArtifactHash: current.artifactHash,
      resultArtifactHash: resultHash,
      prompt: "Undo storefront edit",
      scope: { kind: "undo", restoredVersionId: target.versionId },
      patch: { operations: [{ kind: "restoreVersion", versionId: target.versionId }] },
      provider: { kind: "deterministic", model: null },
      validation: auditJson({ static: validation, browserProof }),
    });
    return { status: "installed", versionId: restoredVersionId, undoneVersionId: current.versionId };
  } catch (error) {
    mapError(error);
  }
}
