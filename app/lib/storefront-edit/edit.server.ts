import { createHash, randomUUID } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { assertCanGenerate } from "~/lib/storegen/guard.server";
import { CalderynError } from "~/lib/calderyn.server";
import { cloneStorefrontBundleAssetProvenance, loadVerifiedStorefrontAssetProofBytes } from "../storefront-bundle/assets.server";
import { isStorefrontCustomBuildEnabled, isStorefrontRecipeBuildEnabled } from "../storefront-bundle/build.server";
import { createAnthropicStructuredProvider, STOREFRONT_DESIGN_MODEL_IDS } from "../storefront-ai/provider.server";
import type { StudioDesignModel } from "../storebuilder/studio-types";
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
import type { CompiledNode, StorefrontBundleV1, StorefrontRouteId } from "../storefront-bundle/types";
import { validateCompiledBundle, type BundleValidationReport } from "../storefront-compiler/validate";
import { storefrontAiBrowserProof } from "../storefront-validation/browser.server";
import { applyDeterministicStorefrontEdit } from "./deterministic";
import { parseEditIntent } from "./intent";
import { applyStorefrontPatch, StorefrontPatchError } from "./patch.server";
import { STOREFRONT_PATCH_SYSTEM_PROMPT, storefrontPatchPrompt } from "./prompts";
import { patchFitsRecipeOverride } from "./recipe-override";
import type {
  CompiledStorefrontPatch,
  LoadedStorefrontDraft,
  PreviewEditContext,
  StructuralPatchScope,
  StorefrontEditEvent,
  StorefrontEditReceipt,
  StorefrontPatchOperation,
  StorefrontStartOverReceipt,
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
  loadEditAudit(input: { shopId: string; resultVersionId: string }): Promise<{ baseVersionId: string; resultVersionId: string } | null>;
  recipeBuildEnabled(): boolean;
  customBuildEnabled(): boolean;
  preflight(input: { shopId: string; prompt: string; trusted: boolean }): Promise<void>;
  compileStructuralPatch(input: {
    prompt: string;
    context?: PreviewEditContext;
    bundle: StorefrontBundleV1;
    signal?: AbortSignal;
    designModel?: StudioDesignModel;
    repair?: { attempt: 1; scope: StructuralPatchScope; staticDiagnostics?: BundleValidationReport["diagnostics"]; browserProof?: BrowserProofReport };
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
    signal?: AbortSignal;
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

async function loadEditAudit(input: { shopId: string; resultVersionId: string }): Promise<{ baseVersionId: string; resultVersionId: string } | null> {
  const result = await getSupabase()
    .from("storefront_bundle_edit")
    .select("base_version_id, result_version_id")
    .eq("shop_id", input.shopId)
    .eq("result_version_id", input.resultVersionId)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;
  return { baseVersionId: String(result.data.base_version_id), resultVersionId: String(result.data.result_version_id) };
}

const PATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array", minItems: 1, maxItems: 32,
      items: {
        oneOf: [
          {
            type: "object", additionalProperties: false,
            required: ["kind", "routeId", "targetId", "value", "expected"],
            properties: {
              kind: { const: "replaceTextChildren" }, routeId: { enum: ["home", "collection", "product", "search", "cart", "checkout"] },
              targetId: { type: "string", maxLength: 120 }, value: { type: "string", minLength: 1, maxLength: 500 },
              expected: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
            },
          },
          {
            type: "object", additionalProperties: false,
            required: ["kind", "routeId", "targetId", "hidden", "expected"],
            properties: {
              kind: { const: "setVisibility" }, routeId: { enum: ["home", "collection", "product", "search", "cart", "checkout"] },
              targetId: { type: "string", maxLength: 120 }, hidden: { type: "boolean" },
              expected: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
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

function parseProviderOperations(value: unknown, scope?: StructuralPatchScope): StorefrontPatchOperation[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { operations?: unknown }).operations)) {
    throw new StorefrontEditError("storefront_patch_invalid", "The patch compiler returned an invalid operation list.", 502);
  }
  const operations = (value as { operations: unknown[] }).operations;
  if (operations.length < 1 || operations.length > 32) throw new StorefrontEditError("storefront_patch_invalid", "The patch compiler returned too many operations.", 502);
  const parsed = operations.map((candidate): StorefrontPatchOperation => {
    if (!candidate || typeof candidate !== "object") throw new StorefrontEditError("storefront_patch_invalid", "A patch operation was malformed.", 502);
    const op = candidate as Record<string, unknown>;
    if (!new Set(["home", "collection", "product", "search", "cart", "checkout"]).has(String(op.routeId))) {
      throw new StorefrontEditError("storefront_patch_invalid", "A patch route was not allowed.", 502);
    }
    const routeId = op.routeId as StorefrontRouteId;
    if (scope && routeId !== scope.routeId) {
      throw new StorefrontEditError("storefront_patch_scope", "The patch compiler attempted to edit outside the selected preview region.", 502);
    }
    if (scope?.regionId && (op.kind === "replaceRouteCss" || op.targetId !== scope.regionId)) {
      throw new StorefrontEditError("storefront_patch_scope", "The patch compiler attempted to edit outside the selected preview region.", 502);
    }
    if (op.kind === "replaceTextChildren" && typeof op.targetId === "string" && typeof op.value === "string" &&
        typeof op.expected === "string" && /^sha256:[a-f0-9]{64}$/.test(op.expected)) {
      return { kind: "replaceTextChildren", routeId, targetId: op.targetId, value: op.value, expected: op.expected };
    }
    if (op.kind === "setVisibility" && typeof op.targetId === "string" && typeof op.hidden === "boolean" &&
        typeof op.expected === "string" && /^sha256:[a-f0-9]{64}$/.test(op.expected)) {
      return { kind: "setVisibility", routeId, targetId: op.targetId, hidden: op.hidden, expected: op.expected };
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
  return parsed;
}

export function createDefaultStructuralPatchCompiler(provider?: StorefrontAiProvider) {
  return async (input: {
    prompt: string;
    context?: PreviewEditContext;
    bundle: StorefrontBundleV1;
    signal?: AbortSignal;
    designModel?: StudioDesignModel;
    repair?: { attempt: 1; scope: StructuralPatchScope; staticDiagnostics?: BundleValidationReport["diagnostics"]; browserProof?: BrowserProofReport };
  }): Promise<CompiledStorefrontPatch> => {
    const structuredProvider = provider ?? createAnthropicStructuredProvider(
      input.designModel ? { model: STOREFRONT_DESIGN_MODEL_IDS[input.designModel] } : {},
    );
    const request = {
      operation: "patch",
      system: STOREFRONT_PATCH_SYSTEM_PROMPT,
      prompt: storefrontPatchPrompt(input),
      schema: PATCH_SCHEMA,
      signal: input.signal,
    } as const;
    let response = await structuredProvider.complete(request);
    let usage = response.usage;
    let operations: StorefrontPatchOperation[];
    try {
      operations = parseProviderOperations(response.value, input.context ?? input.repair?.scope);
    } catch (error) {
      if (!(error instanceof StorefrontEditError) || error.code !== "storefront_patch_invalid") throw error;
      const retryResponse = await structuredProvider.complete({
        ...request,
        prompt: `${request.prompt}\nYour previous result did not match the required operations object. Return exactly one object with a non-empty operations array that matches the supplied schema.`,
      });
      usage = {
        inputTokens: usage.inputTokens + retryResponse.usage.inputTokens,
        outputTokens: usage.outputTokens + retryResponse.usage.outputTokens,
      };
      response = retryResponse;
      operations = parseProviderOperations(response.value, input.context ?? input.repair?.scope);
    }
    return {
      operations,
      provider: { kind: "ai_patch", provider: response.provider, model: response.model, usage },
    };
  };
}

const defaultDependencies: StorefrontEditDependencies = {
  loadDraft,
  loadVersion,
  loadEditAudit,
  recipeBuildEnabled: isStorefrontRecipeBuildEnabled,
  customBuildEnabled: isStorefrontCustomBuildEnabled,
  preflight: ({ shopId, prompt, trusted }) => assertCanGenerate(shopId, prompt, { trusted }),
  compileStructuralPatch: (input) => createDefaultStructuralPatchCompiler()(input),
  validate: validateCompiledBundle,
  loadProofContext: ({ shopId, prompt }) => assembleStorefrontContext({ shopId, prompt }),
  loadProofAssets: ({ shopId, versionId, manifest }) => loadVerifiedStorefrontAssetProofBytes({ shopId, bundleId: versionId, manifest }),
  prove: ({ bundle, context, persistedAssets, signal }) => storefrontAiBrowserProof({ bundle, context, persistedAssets, signal }),
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

function catalogFingerprint(context: MerchantStorefrontContext): string {
  if (!Array.isArray(context.collections) || !Array.isArray(context.products)) return context.fingerprint;
  const catalog = {
    collections: context.collections.map(({ id, handle, productCount }) => ({ id, handle, productCount })),
    products: context.products.map(({ id, handle, productType, tags, optionNames, availability, collectionIds }) => ({
      id, handle, productType, tags, optionNames, availability, collectionIds: collectionIds ?? [],
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(catalog)).digest("hex")}`;
}

function auditJson(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function recipeFields(bundle: StorefrontBundleV1) {
  return bundle.source.kind === "recipe"
    ? { sourceKind: "recipe" as const, templateId: bundle.source.templateId, templateVersion: bundle.source.templateVersion }
    : { sourceKind: "custom" as const, templateId: null, templateVersion: null };
}

function assertEditWriterEnabled(
  sourceKind: StorefrontBundleV1["source"]["kind"],
  dependencies: StorefrontEditDependencies,
): void {
  if (sourceKind === "recipe" && !dependencies.recipeBuildEnabled()) {
    throw new StorefrontEditError(
      "storefront_recipe_build_disabled",
      "Recipe storefront builds are temporarily disabled. Your current draft was not changed.",
      503,
    );
  }
  if (sourceKind === "custom" && !dependencies.customBuildEnabled()) {
    throw new StorefrontEditError(
      "storefront_custom_build_disabled",
      "Original AI storefront generation is not available right now. Your current draft was not changed.",
      503,
    );
  }
}

function databaseValidationReport(validation: BundleValidationReport): Record<string, unknown> {
  return { ...validation, valid: validation.ok } as unknown as Record<string, unknown>;
}

interface EditAttemptAudit {
  attempt: number;
  patch: CompiledStorefrontPatch;
  staticDiagnostics: BundleValidationReport["diagnostics"];
  browserDiagnostics: BrowserProofReport["diagnostics"];
  browserMs: number;
}

function boundedDiagnostics<T extends { code: string; message: string }>(diagnostics: readonly T[]): T[] {
  return diagnostics.slice(0, 24).map((diagnostic) => ({
    ...diagnostic,
    code: diagnostic.code.slice(0, 120),
    message: diagnostic.message.slice(0, 500),
  }));
}

function operationSummary(operation: StorefrontPatchOperation): Record<string, unknown> {
  if (operation.kind === "replaceRegion") {
    return {
      kind: operation.kind,
      routeId: operation.routeId,
      targetId: operation.targetId,
      expected: operation.expected,
      sourceHash: promptHash(`${operation.source.html}\u0000${operation.source.css}`),
      htmlBytes: Buffer.byteLength(operation.source.html),
      cssBytes: Buffer.byteLength(operation.source.css),
    };
  }
  if (operation.kind === "replaceRouteCss") {
    return {
      kind: operation.kind,
      routeId: operation.routeId,
      expected: operation.expected,
      cssHash: promptHash(operation.css),
      cssBytes: Buffer.byteLength(operation.css),
    };
  }
  return { ...operation } as unknown as Record<string, unknown>;
}

function repairScopeFromStatic(
  diagnostics: BundleValidationReport["diagnostics"],
  selected?: PreviewEditContext,
): { scope: StructuralPatchScope; diagnostics: BundleValidationReport["diagnostics"] } | null {
  const diagnostic = diagnostics.find((entry) => /^routes\.(home|collection|product|search|cart|checkout)(?:\.|$)/.test(entry.path));
  const routeId = diagnostic?.path.match(/^routes\.(home|collection|product|search|cart|checkout)(?:\.|$)/)?.[1] as StorefrontRouteId | undefined;
  if (!diagnostic || !routeId || (selected && selected.routeId !== routeId)) return null;
  return { scope: { routeId, ...(selected?.regionId ? { regionId: selected.regionId } : {}) }, diagnostics: [diagnostic] };
}

function repairScopeFromBrowser(
  proof: BrowserProofReport,
  selected?: PreviewEditContext,
): { scope: StructuralPatchScope; proof: BrowserProofReport } | null {
  const diagnostic = proof.diagnostics[0];
  if (!diagnostic || (selected && selected.routeId !== diagnostic.routeId) ||
      (selected && diagnostic.regionId && selected.regionId !== diagnostic.regionId)) return null;
  const scope: StructuralPatchScope = {
    routeId: diagnostic.routeId,
    ...(diagnostic.regionId ?? selected?.regionId ? { regionId: diagnostic.regionId ?? selected!.regionId } : {}),
  };
  return { scope, proof: { ...proof, diagnostics: [diagnostic] } };
}

async function proveEditBundle(
  bundle: StorefrontBundleV1,
  context: MerchantStorefrontContext,
  persistedAssets: MaterializedAssetResult["proofAssets"],
  dependencies: StorefrontEditDependencies,
  signal?: AbortSignal,
): Promise<BrowserProofReport> {
  try {
    const report = await dependencies.prove({ bundle, context, persistedAssets, signal });
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
    if (signal?.aborted) throw new StorefrontEditError("storefront_edit_cancelled", "Storefront generation was stopped. Your draft was not changed.", 409);
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

function throwIfEditAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new StorefrontEditError("storefront_edit_cancelled", "Storefront generation was stopped. Your draft was not changed.", 409);
  }
}

function mergeScopedRepair(
  original: CompiledStorefrontPatch,
  repaired: CompiledStorefrontPatch,
  scope: StructuralPatchScope,
): CompiledStorefrontPatch {
  const untouched = original.operations.filter((operation) =>
    !("routeId" in operation) || operation.routeId !== scope.routeId,
  );
  return { ...repaired, operations: [...untouched, ...repaired.operations] };
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

function repeatOwnerId(nodes: readonly CompiledNode[], targetId: string, ownerId?: string): string | null {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    const nextOwner = ownerId ?? (node.repeat ? node.id : undefined);
    if (node.id === targetId) return nextOwner ?? node.id;
    const nested = repeatOwnerId(node.children, targetId, nextOwner);
    if (nested) return nested;
  }
  return null;
}

function safeStructuralContext(bundle: StorefrontBundleV1, context?: PreviewEditContext): PreviewEditContext | undefined {
  if (!context || context.routeId === "checkout") return context;
  const route = bundle.routes[context.routeId];
  const regionId = repeatOwnerId(route.tree, context.regionId) ?? context.regionId;
  return { ...context, regionId };
}

const COMPILED_BINDING_ATTRIBUTE = /\bdata-cd-bind-(text|money|src|alt)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;

function restoreKnownBindingSources(bundle: StorefrontBundleV1, patch: CompiledStorefrontPatch): CompiledStorefrontPatch {
  return {
    ...patch,
    operations: patch.operations.map((operation) => {
      if (operation.kind !== "replaceRegion") return operation;
      const sourceByMarker = new Map<string, string>(bundle.routes[operation.routeId].bindings.flatMap((binding) =>
        binding.ref.kind === "data" ? [[`${binding.kind}:${binding.id}`, binding.ref.path] as const] : [],
      ));
      const html = operation.source.html.replace(
        COMPILED_BINDING_ATTRIBUTE,
        (attribute, kind: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
          const bindingId = doubleQuoted ?? singleQuoted ?? unquoted;
          const bindingPath = bindingId ? sourceByMarker.get(`${kind.toLowerCase()}:${bindingId}`) : undefined;
          return bindingPath ? `data-cd-${kind.toLowerCase()}="${bindingPath}"` : attribute;
        },
      );
      return html === operation.source.html ? operation : { ...operation, source: { ...operation.source, html } };
    }),
  };
}

function failingReplacement(
  bundle: StorefrontBundleV1,
  operations: readonly StorefrontPatchOperation[],
  failure: StorefrontPatchError,
): Extract<StorefrontPatchOperation, { kind: "replaceRegion" }> | undefined {
  for (const operation of operations) {
    if (operation.kind !== "replaceRegion") continue;
    try {
      applyStorefrontPatch(bundle, [operation]);
    } catch (error) {
      if (error instanceof StorefrontPatchError && error.code === failure.code && error.message === failure.message) return operation;
    }
  }
  return undefined;
}

export async function editStorefrontByPrompt(
  input: {
    shopId: string;
    actorId?: string | null;
    prompt: string;
    expectedDraftVersionId: string;
    context?: PreviewEditContext;
    trusted?: boolean;
    signal?: AbortSignal;
    designModel?: StudioDesignModel;
    onEvent?: (event: StorefrontEditEvent) => void;
  },
  dependencies: StorefrontEditDependencies = defaultDependencies,
): Promise<StorefrontEditReceipt | StorefrontStartOverReceipt> {
  const intent = parseEditIntent(input.prompt, input.context);
  if (intent.kind === "startOver") return { status: "start_over", mode: intent.mode };
  try {
    throwIfEditAborted(input.signal);
    const base = await dependencies.loadDraft(input.shopId);
    throwIfEditAborted(input.signal);
    if (!base) throw new StorefrontEditError("storefront_edit_unavailable", "There is no runtime-1 draft to edit.", 409);
    if (base.versionId !== input.expectedDraftVersionId) {
      throw new StorefrontEditError("storefront_edit_conflict", "The storefront draft changed before this edit.", 409);
    }
    assertEditWriterEnabled(base.bundle.source.kind, dependencies);
    // Structural recipe edits use the AI patch compiler and may detach into a
    // custom-derived bundle, so the custom writer must be live before quota or
    // provider spend even while the current draft remains recipe-linked.
    if (intent.kind === "structural" && base.bundle.source.kind === "recipe") {
      assertEditWriterEnabled("custom", dependencies);
    }
    const structuralContext = intent.kind === "structural" ? safeStructuralContext(base.bundle, intent.context) : undefined;
    input.onEvent?.({ stage: "compiling" });
    let compiledPatch = intent.kind === "deterministic"
      ? { operations: intent.operations, provider: { kind: "deterministic" as const, model: null } }
      : await (async () => {
          await dependencies.preflight({ shopId: input.shopId, prompt: input.prompt, trusted: input.trusted ?? false });
          return dependencies.compileStructuralPatch({ prompt: input.prompt, context: structuralContext, bundle: base.bundle, signal: input.signal, designModel: input.designModel });
        })();
    throwIfEditAborted(input.signal);
    let applied: ReturnType<typeof applyStorefrontPatch>;
    let validation: BundleValidationReport;
    let browserProof: BrowserProofReport;
    let proofContext: MerchantStorefrontContext | null = null;
    let proofAssets: MaterializedAssetResult["proofAssets"] | null = null;
    let repairAttempted = false;
    let repeatScopeAdjusted = false;
    const attemptAudits: EditAttemptAudit[] = [];
    for (;;) {
      if (intent.kind === "structural") compiledPatch = restoreKnownBindingSources(base.bundle, compiledPatch);
      try {
        applied = intent.kind === "deterministic"
          ? applyDeterministicStorefrontEdit(base.bundle, compiledPatch.operations)
          : applyStorefrontPatch(base.bundle, compiledPatch.operations);
      } catch (error) {
        const replacement = error instanceof StorefrontPatchError
          ? failingReplacement(base.bundle, compiledPatch.operations, error)
          : undefined;
        const repeatContext = replacement
          ? safeStructuralContext(base.bundle, { routeId: replacement.routeId, regionId: replacement.targetId })
          : undefined;
        if (intent.kind === "structural" && error instanceof StorefrontPatchError && error.code === "patch_scope_invalid" &&
            !repeatScopeAdjusted && replacement && repeatContext && repeatContext.regionId !== replacement.targetId) {
          repeatScopeAdjusted = true;
          const repaired = await dependencies.compileStructuralPatch({
            prompt: input.prompt,
            context: repeatContext,
            bundle: base.bundle,
            signal: input.signal,
            designModel: input.designModel,
            repair: { attempt: 1, scope: repeatContext },
          });
          compiledPatch = mergeScopedRepair(compiledPatch, repaired, repeatContext);
          throwIfEditAborted(input.signal);
          continue;
        }
        if (intent.kind === "structural" && error instanceof StorefrontPatchError && error.code === "patch_source_invalid" &&
            !repairAttempted && replacement && repeatContext) {
          repairAttempted = true;
          const repaired = await dependencies.compileStructuralPatch({
            prompt: input.prompt,
            context: repeatContext,
            bundle: base.bundle,
            signal: input.signal,
            designModel: input.designModel,
            repair: {
              attempt: 1,
              scope: repeatContext,
              staticDiagnostics: [{ code: error.code, path: "source.html", message: error.message }],
            },
          });
          compiledPatch = mergeScopedRepair(compiledPatch, repaired, repeatContext);
          throwIfEditAborted(input.signal);
          continue;
        }
        throw error;
      }
      if (JSON.stringify(applied.bundle) === JSON.stringify(base.bundle)) {
        throw new StorefrontEditError("storefront_edit_no_change", "That request did not change the storefront.", 422);
      }
      const shouldDetach = base.bundle.source.kind === "recipe" && !patchFitsRecipeOverride(base.bundle, compiledPatch.operations);
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
      // A deterministic recipe edit can still leave the declared override
      // surface. Gate the resulting source before browser proof or writes.
      assertEditWriterEnabled(applied.bundle.source.kind, dependencies);
      input.onEvent?.({ stage: "validating" });
      validation = dependencies.validate(applied.bundle);
      if (!validation.ok) {
        attemptAudits.push({
          attempt: attemptAudits.length + 1,
          patch: compiledPatch,
          staticDiagnostics: boundedDiagnostics(validation.diagnostics),
          browserDiagnostics: [],
          browserMs: 0,
        });
        const repair = intent.kind === "structural" ? repairScopeFromStatic(validation.diagnostics, structuralContext) : null;
        if (repair && !repairAttempted) {
          repairAttempted = true;
          const repaired = await dependencies.compileStructuralPatch({
            prompt: input.prompt,
            context: structuralContext,
            bundle: base.bundle,
            signal: input.signal,
            designModel: input.designModel,
            repair: { attempt: 1, scope: repair.scope, staticDiagnostics: repair.diagnostics },
          });
          compiledPatch = mergeScopedRepair(compiledPatch, repaired, repair.scope);
          throwIfEditAborted(input.signal);
          continue;
        }
        throw new StorefrontEditError("storefront_edit_invalid", "The requested change did not pass storefront validation. Your draft was not changed.", 422, validation.diagnostics);
      }
      try {
        proofContext ??= await dependencies.loadProofContext({ shopId: input.shopId, prompt: input.prompt });
        proofAssets ??= needsOwnedProofAssets(base.bundle)
          ? await dependencies.loadProofAssets({ shopId: input.shopId, versionId: base.versionId, manifest: base.bundle.assets })
          : [];
        input.onEvent?.({ stage: "proofing" });
        browserProof = await proveEditBundle(applied.bundle, proofContext, proofAssets, dependencies, input.signal);
        attemptAudits.push({
          attempt: attemptAudits.length + 1,
          patch: compiledPatch,
          staticDiagnostics: [],
          browserDiagnostics: [],
          browserMs: browserProof.browserMs,
        });
        break;
      } catch (error) {
        const failedProof = error instanceof StorefrontEditError && error.details && typeof error.details === "object" &&
          "ok" in error.details && (error.details as BrowserProofReport).ok === false
          ? error.details as BrowserProofReport
          : null;
        if (failedProof) {
          attemptAudits.push({
            attempt: attemptAudits.length + 1,
            patch: compiledPatch,
            staticDiagnostics: [],
            browserDiagnostics: boundedDiagnostics(failedProof.diagnostics),
            browserMs: failedProof.browserMs,
          });
        }
        const repair = intent.kind === "structural" && failedProof ? repairScopeFromBrowser(failedProof, structuralContext) : null;
        if (repair && !repairAttempted) {
          repairAttempted = true;
          const repaired = await dependencies.compileStructuralPatch({
            prompt: input.prompt,
            context: structuralContext,
            bundle: base.bundle,
            signal: input.signal,
            designModel: input.designModel,
            repair: { attempt: 1, scope: repair.scope, browserProof: repair.proof },
          });
          compiledPatch = mergeScopedRepair(compiledPatch, repaired, repair.scope);
          throwIfEditAborted(input.signal);
          continue;
        }
        throw error;
      }
    }
    input.onEvent?.({ stage: "installing" });
    throwIfEditAborted(input.signal);
    const detached = base.bundle.source.kind === "recipe" && !patchFitsRecipeOverride(base.bundle, compiledPatch.operations);
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
    throwIfEditAborted(input.signal);
    await dependencies.editDraft({
      shopId: input.shopId,
      baseVersionId: base.versionId,
      resultVersionId: versionId,
      expectedDraftVersionId: input.expectedDraftVersionId,
      actorId: input.actorId ?? null,
      baseArtifactHash: base.artifactHash,
      resultArtifactHash: resultHash,
      prompt: input.prompt,
      scope: auditJson({
        ...applied.changedScope,
        auditContractVersion: 1,
        selectedScope: input.context ?? null,
        compiler: {
          schemaVersion: applied.bundle.schemaVersion,
          runtimeVersion: applied.bundle.runtimeVersion,
          validationProfileVersion: applied.bundle.validationProfileVersion,
        },
      }),
      patch: {
        contractVersion: 1,
        operations: compiledPatch.operations,
        attempts: attemptAudits.map((attempt) => ({ attempt: attempt.attempt, operations: attempt.patch.operations.map(operationSummary) })),
      },
      provider: auditJson({
        ...compiledPatch.provider,
        attempts: attemptAudits.map((attempt) => ({ attempt: attempt.attempt, ...attempt.patch.provider })),
        totalUsage: attemptAudits.reduce((usage, attempt) => ({
          inputTokens: usage.inputTokens + (attempt.patch.provider.usage?.inputTokens ?? 0),
          outputTokens: usage.outputTokens + (attempt.patch.provider.usage?.outputTokens ?? 0),
        }), { inputTokens: 0, outputTokens: 0 }),
      }),
      validation: auditJson({
        static: validation,
        browserProof,
        proofContextFingerprint: proofContext?.fingerprint ?? null,
        catalogFingerprint: proofContext ? catalogFingerprint(proofContext) : null,
        attempts: attemptAudits.map((attempt) => ({
          attempt: attempt.attempt,
          staticDiagnostics: attempt.staticDiagnostics,
          browserDiagnostics: attempt.browserDiagnostics,
          browserMs: attempt.browserMs,
        })),
      }),
    });
    const receipt: StorefrontEditReceipt = {
      status: "installed",
      versionId,
      baseVersionId: base.versionId,
      bundle: applied.bundle,
      changedScope: applied.changedScope,
      browserProof,
      detachedFromRecipe: detached,
      undo: { targetVersionId: base.versionId, expectedDraftVersionId: versionId },
    };
    input.onEvent?.({ stage: "installed", receipt });
    return receipt;
  } catch (error) {
    if (input.signal?.aborted) throwIfEditAborted(input.signal);
    mapError(error);
  }
}

export async function undoStorefrontEdit(
  input: { shopId: string; actorId?: string | null; expectedDraftVersionId: string; targetVersionId: string },
  dependencies: StorefrontEditDependencies = defaultDependencies,
): Promise<{ status: "installed"; versionId: string; undoneVersionId: string }> {
  try {
    const current = await dependencies.loadDraft(input.shopId);
    if (!current || current.versionId !== input.expectedDraftVersionId) {
      throw new StorefrontEditError("storefront_edit_conflict", "The storefront draft changed before undo.", 409);
    }
    const audit = await dependencies.loadEditAudit({ shopId: input.shopId, resultVersionId: current.versionId });
    if (!audit || audit.resultVersionId !== current.versionId || audit.baseVersionId !== input.targetVersionId) {
      throw new StorefrontEditError("storefront_undo_target_invalid", "The requested version is not the recorded base of the current storefront edit.", 409);
    }
    const target = await dependencies.loadVersion(input.shopId, input.targetVersionId);
    if (!target) throw new StorefrontEditError("storefront_undo_target_missing", "The undo version is no longer available.", 409);
    assertEditWriterEnabled(target.bundle.source.kind, dependencies);
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
