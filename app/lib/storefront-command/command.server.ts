import { getSupabase } from "~/lib/supabase.server";
import type { BrowserProofReport, MerchantStorefrontContext } from "~/lib/storefront-ai/contracts";
import { assembleStorefrontContext } from "~/lib/storefront-ai/context.server";
import {
  isStorefrontBundlePublishEnabled,
  isStorefrontRecipeBuildEnabled,
  loadStorefrontRecipe,
  type StorefrontRecipeArtifact,
} from "~/lib/storefront-bundle/build.server";
import { getStoreTemplate, isStoreTemplateId, STORE_TEMPLATE_REGISTRY } from "~/lib/storefront-bundle/registry";
import {
  assertStorefrontWriteAllowed,
  createStorefrontBundleVersion,
  editStorefrontDraft,
  hashStorefrontArtifact,
  installStorefrontDraft,
  publishStorefrontRelease,
  StorefrontReleaseError,
  type CreateStorefrontBundleVersionInput,
  type EditStorefrontDraftInput,
  type HashStorefrontArtifactInput,
  type InstallStorefrontDraftInput,
  type PublishStorefrontReleaseInput,
} from "~/lib/storefront-bundle/release.server";
import { buildCatalogRoutingEvidence } from "~/lib/storefront-bundle/routing-evidence.server";
import { resolveStoreDesign } from "~/lib/storefront-bundle/routing";
import type {
  CatalogRoutingEvidence,
  StoreDesignRequest,
  StoreDesignResolution,
  StorefrontBundleV1,
  StoreTemplateId,
  VersionedStoreTemplate,
} from "~/lib/storefront-bundle/types";
import { validateCompiledBundle, type BundleValidationReport } from "~/lib/storefront-compiler/validate";
import { StorefrontUndoError, undoStorefrontEdit } from "~/lib/storefront-edit/undo.server";
import { isStorefrontBundleReadEnabled } from "~/lib/storefront-runtime/csp.server";
import { requirePublishableTenantDomain } from "~/lib/storebuilder/studio.server";
import { storefrontAiBrowserProof } from "~/lib/storefront-validation/browser.server";
import { applyStoreIntent } from "./apply";
import { classifyStoreIntent } from "./intent.server";
import type { StoreCommand, StoreCommandEvent, StoreCommandReceipt, StoreIntent } from "./types";

export interface LoadedStoreCommandVersion {
  versionId: string;
  artifactHash: string;
  bundle: StorefrontBundleV1;
  resolution: Record<string, unknown>;
}

export interface StoreCommandState {
  draft: LoadedStoreCommandVersion | null;
  publishedVersionId: string | null;
}

export interface StoreCommandDependencies {
  loadState(shopId: string): Promise<StoreCommandState>;
  assertWriteAllowed(shopId: string): Promise<void>;
  assertPublishable(shopId: string): Promise<void>;
  readEnabled(): boolean;
  recipeBuildEnabled(): boolean;
  publishEnabled(): boolean;
  buildEvidence(shopId: string): Promise<CatalogRoutingEvidence>;
  loadContext(input: { shopId: string; prompt: string }): Promise<MerchantStorefrontContext>;
  classify(input: Parameters<typeof classifyStoreIntent>[0]): Promise<StoreIntent>;
  resolveDesign(request: StoreDesignRequest, evidence: CatalogRoutingEvidence): StoreDesignResolution;
  loadRecipe(templateId: StoreTemplateId, templateVersion: number): Promise<StorefrontRecipeArtifact>;
  applyIntent(bundle: StorefrontBundleV1, template: VersionedStoreTemplate, intent: StoreIntent): { bundle: StorefrontBundleV1 };
  validate(bundle: StorefrontBundleV1): BundleValidationReport;
  prove(input: {
    bundle: StorefrontBundleV1;
    context: MerchantStorefrontContext;
    persistedAssets: [];
    signal?: AbortSignal;
  }): Promise<BrowserProofReport>;
  hashArtifact(input: HashStorefrontArtifactInput): Promise<string>;
  createVersion(input: CreateStorefrontBundleVersionInput): Promise<string>;
  install(input: InstallStorefrontDraftInput): Promise<string>;
  edit(input: EditStorefrontDraftInput): Promise<string>;
  undo(input: { shopId: string; actorId?: string | null; expectedDraftVersionId: string; targetVersionId: string; signal?: AbortSignal }): Promise<{
    status: "installed";
    versionId: string;
    undoneVersionId: string;
  }>;
  publish(input: PublishStorefrontReleaseInput): Promise<string>;
}

export interface RunStoreCommandInput {
  shopId: string;
  actorId?: string | null;
  command: StoreCommand;
  onEvent?: (event: StoreCommandEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

export class StoreCommandError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StoreCommandError";
  }
}

function isBundle(value: unknown): value is StorefrontBundleV1 {
  return Boolean(value) && typeof value === "object" && (value as StorefrontBundleV1).runtimeVersion === 1;
}

function extractBundle(value: unknown): StorefrontBundleV1 | null {
  if (!value || typeof value !== "object") return null;
  const artifact = value as Record<string, unknown>;
  return isBundle(artifact.bundle) ? artifact.bundle : isBundle(value) ? value : null;
}

async function loadState(shopId: string): Promise<StoreCommandState> {
  const release = await getSupabase()
    .from("storefront_release")
    .select("draft_version_id, published_version_id")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (release.error) throw release.error;
  const draftVersionId = typeof release.data?.draft_version_id === "string" ? release.data.draft_version_id : null;
  const publishedVersionId = typeof release.data?.published_version_id === "string" ? release.data.published_version_id : null;
  if (!draftVersionId) return { draft: null, publishedVersionId };

  const version = await getSupabase()
    .from("storefront_bundle_version")
    .select("id, artifact_hash, bundle_json, resolution_json, runtime_version, status")
    .eq("shop_id", shopId)
    .eq("id", draftVersionId)
    .maybeSingle();
  if (version.error) throw version.error;
  const row = version.data as Record<string, unknown> | null;
  const bundle = extractBundle(row?.bundle_json);
  if (!row || row.status !== "validated" || Number(row.runtime_version) !== 1 || !bundle) {
    throw new StoreCommandError(
      "storefront_command_unavailable",
      "This storefront draft cannot be changed with chat yet.",
      503,
    );
  }
  const resolution = row.resolution_json && typeof row.resolution_json === "object" && !Array.isArray(row.resolution_json)
    ? row.resolution_json as Record<string, unknown>
    : {};
  return {
    draft: {
      versionId: String(row.id),
      artifactHash: String(row.artifact_hash),
      bundle,
      resolution,
    },
    publishedVersionId,
  };
}

const defaultDependencies: StoreCommandDependencies = {
  loadState,
  assertWriteAllowed: assertStorefrontWriteAllowed,
  assertPublishable: async (shopId) => { await requirePublishableTenantDomain(shopId); },
  readEnabled: isStorefrontBundleReadEnabled,
  recipeBuildEnabled: isStorefrontRecipeBuildEnabled,
  publishEnabled: isStorefrontBundlePublishEnabled,
  buildEvidence: buildCatalogRoutingEvidence,
  loadContext: assembleStorefrontContext,
  classify: classifyStoreIntent,
  resolveDesign: (request, evidence) => resolveStoreDesign(request, evidence, STORE_TEMPLATE_REGISTRY),
  loadRecipe: loadStorefrontRecipe,
  applyIntent: applyStoreIntent,
  validate: validateCompiledBundle,
  prove: storefrontAiBrowserProof,
  hashArtifact: hashStorefrontArtifact,
  createVersion: createStorefrontBundleVersion,
  install: installStorefrontDraft,
  edit: editStorefrontDraft,
  undo: undoStorefrontEdit,
  publish: publishStorefrontRelease,
};

function abortError(): StoreCommandError {
  return new StoreCommandError(
    "generation_cancelled",
    "Storefront generation was stopped. Your current draft was not changed.",
    409,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

const PUBLIC_CONFLICT_CODES = new Set([
  "storefront_command_conflict",
  "storefront_draft_conflict",
  "storefront_edit_conflict",
  "storefront_publish_conflict",
]);

function publicError(code: string): StoreCommandError {
  if (code === "generation_cancelled") return abortError();
  if (PUBLIC_CONFLICT_CODES.has(code)) {
    return new StoreCommandError(
      "storefront_command_conflict",
      "The storefront changed before this request. Refresh and try again.",
      409,
    );
  }
  if (code === "storefront_command_invalid" || code === "storefront_command_proof_failed") {
    return new StoreCommandError(
      "storefront_command_rejected",
      "That storefront change could not be applied safely. Your current draft was not changed.",
      422,
    );
  }
  if (
    code === "storefront_bundle_read_disabled"
    || code === "storefront_recipe_build_disabled"
    || code === "storefront_bundle_publish_disabled"
    || code === "storefront_command_unavailable"
  ) {
    return new StoreCommandError(
      "storefront_command_unavailable",
      "Storefront changes are temporarily unavailable. Your current draft was not changed.",
      503,
    );
  }
  return new StoreCommandError(
    "storefront_command_failed",
    "The storefront change could not be completed. Your current draft was not changed.",
    500,
  );
}

function normalizedError(error: unknown, signal?: AbortSignal): StoreCommandError {
  if (signal?.aborted) return abortError();
  const trusted = error instanceof StoreCommandError
    || error instanceof StorefrontReleaseError
    || error instanceof StorefrontUndoError;
  if (trusted && error.status === 409) return publicError("storefront_command_conflict");
  const candidate = error && typeof error === "object" ? error as { code?: unknown } : null;
  const safe = publicError(typeof candidate?.code === "string" ? candidate.code : "storefront_command_failed");
  return new StoreCommandError(safe.code, safe.message, safe.status, error);
}

async function emit(input: RunStoreCommandInput, event: StoreCommandEvent): Promise<void> {
  await input.onEvent?.(event);
}

async function ready(input: RunStoreCommandInput, receipt: StoreCommandReceipt): Promise<StoreCommandReceipt> {
  await emit(input, { stage: "ready", receipt });
  return receipt;
}

function expectedDraft(command: StoreCommand): string | null {
  return command.expectedDraftVersionId;
}

function exclusions(resolution: Record<string, unknown>): StoreTemplateId[] {
  const value = resolution.excludedTemplateIds;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isStoreTemplateId))];
}

function uniqueTemplateIds(values: readonly StoreTemplateId[]): StoreTemplateId[] {
  return [...new Set(values)];
}

function unchanged(message: string): StoreCommandReceipt {
  return { status: "unchanged", message };
}

function artifact(bundle: StorefrontBundleV1): { sourceKind: "recipe"; bundle: StorefrontBundleV1 } {
  if (bundle.source.kind !== "recipe") {
    throw new StoreCommandError("storefront_command_unavailable", "This storefront draft cannot be changed with chat yet.", 503);
  }
  return { sourceKind: "recipe", bundle };
}

async function loadSelectedRecipe(
  resolution: Extract<StoreDesignResolution, { kind: "recipe" }>,
  dependencies: StoreCommandDependencies,
): Promise<StorefrontRecipeArtifact> {
  const recipe = await dependencies.loadRecipe(resolution.templateId, resolution.templateVersion);
  if (recipe.bundle.source.kind !== "recipe"
    || recipe.bundle.source.templateId !== resolution.templateId
    || recipe.bundle.source.templateVersion !== resolution.templateVersion) {
    throw new StoreCommandError(
      "storefront_recipe_source_mismatch",
      "The selected recipe did not match its immutable source.",
      500,
    );
  }
  return recipe;
}

function sameBundle(left: StorefrontBundleV1, right: StorefrontBundleV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function operationAudit(intent: StoreIntent | null, resolution: StoreDesignResolution | null): Record<string, unknown> {
  if (intent?.kind === "update_text") return { kind: intent.kind, slot: intent.slot };
  if (intent?.kind === "update_merchandising") return { kind: intent.kind, productIds: intent.productIds };
  if (intent?.kind === "update_visual_layer") return { kind: intent.kind, visualLayer: intent.visualLayer };
  if (resolution?.kind === "recipe") {
    return { kind: intent?.kind ?? "initial_design", templateId: resolution.templateId, templateVersion: resolution.templateVersion };
  }
  return { kind: intent?.kind ?? "initial_design" };
}

export async function runStoreCommand(
  input: RunStoreCommandInput,
  dependencies: StoreCommandDependencies = defaultDependencies,
): Promise<StoreCommandReceipt> {
  try {
    throwIfAborted(input.signal);
    const state = await dependencies.loadState(input.shopId);
    throwIfAborted(input.signal);
    const actualDraftVersionId = state.draft?.versionId ?? null;
    if (actualDraftVersionId !== expectedDraft(input.command)) {
      throw new StoreCommandError(
        "storefront_command_conflict",
        "The storefront draft changed before this request.",
        409,
      );
    }
    await dependencies.assertWriteAllowed(input.shopId);
    throwIfAborted(input.signal);

    const actorId = input.actorId ?? null;
    if (input.command.kind === "undo") {
      if (!dependencies.readEnabled() || !dependencies.recipeBuildEnabled()) {
        throw new StoreCommandError(
          dependencies.readEnabled() ? "storefront_recipe_build_disabled" : "storefront_bundle_read_disabled",
          "Storefront changes are temporarily unavailable. Your current draft was not changed.",
          503,
        );
      }
      const result = await dependencies.undo({
        shopId: input.shopId,
        actorId,
        targetVersionId: input.command.targetVersionId,
        expectedDraftVersionId: input.command.expectedDraftVersionId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return ready(input, {
        status: "installed",
        versionId: result.versionId,
        undo: { targetVersionId: result.undoneVersionId, expectedDraftVersionId: result.versionId },
      });
    }

    if (input.command.kind === "publish") {
      if (!dependencies.readEnabled() || !dependencies.recipeBuildEnabled() || !dependencies.publishEnabled()) {
        throw new StoreCommandError(
          !dependencies.readEnabled()
            ? "storefront_bundle_read_disabled"
            : !dependencies.recipeBuildEnabled()
              ? "storefront_recipe_build_disabled"
              : "storefront_bundle_publish_disabled",
          "Publishing is temporarily unavailable. Your draft is unchanged.",
          503,
        );
      }
      await dependencies.assertPublishable(input.shopId);
      throwIfAborted(input.signal);
      const versionId = await dependencies.publish({
        shopId: input.shopId,
        actorId,
        expectedDraftVersionId: input.command.expectedDraftVersionId,
        expectedPublishedVersionId: state.publishedVersionId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return ready(input, { status: "published", versionId });
    }

    await emit(input, { stage: "understanding" });
    if (input.command.attachments?.some(({ kind }) => kind === "design_reference")) {
      return ready(input, unchanged("That design reference could not be matched safely, so your draft was left unchanged."));
    }
    if (!dependencies.readEnabled() || !dependencies.recipeBuildEnabled()) {
      throw new StoreCommandError(
        dependencies.readEnabled() ? "storefront_recipe_build_disabled" : "storefront_bundle_read_disabled",
        "Storefront changes are temporarily unavailable. Your current draft was not changed.",
        503,
      );
    }

    const priorExclusions = state.draft ? exclusions(state.draft.resolution) : [];
    const currentTemplateId = state.draft?.bundle.source.kind === "recipe"
      ? state.draft.bundle.source.templateId
      : undefined;
    let proofContext: MerchantStorefrontContext | null = null;
    let intent: StoreIntent | null = null;
    let designResolution: StoreDesignResolution | null = null;
    let nextExclusions = priorExclusions;
    let nextBundle: StorefrontBundleV1;

    if (!state.draft) {
      const evidence = await dependencies.buildEvidence(input.shopId);
      designResolution = dependencies.resolveDesign({
        prompt: input.command.prompt,
        excludedTemplateIds: [],
      }, evidence);
      nextExclusions = [];
      if (designResolution.kind === "no_match") {
        return ready(input, unchanged("No other approved design is available, so your draft was left unchanged."));
      }
      if (designResolution.kind !== "recipe") {
        throw new StoreCommandError("storefront_command_unavailable", "No approved storefront design is available.", 503);
      }
      const recipe = await loadSelectedRecipe(designResolution, dependencies);
      nextBundle = recipe.bundle;
    } else {
      proofContext = await dependencies.loadContext({ shopId: input.shopId, prompt: input.command.prompt });
      throwIfAborted(input.signal);
      intent = await dependencies.classify({
        prompt: input.command.prompt,
        ...(currentTemplateId ? { currentTemplateId } : {}),
        excludedTemplateIds: priorExclusions,
        bundle: state.draft.bundle,
        productCandidates: proofContext.products.slice(0, 100).map(({ id, title }) => ({ id, title })),
        ...(input.command.context ? { context: input.command.context } : {}),
        ...(input.command.attachments ? { attachments: input.command.attachments } : {}),
      });
      throwIfAborted(input.signal);

      if (intent.kind === "unsupported") {
        return ready(input, unchanged("I couldn't apply that request safely, so your draft was left unchanged."));
      }
      if (intent.kind === "select_design" || intent.kind === "start_over") {
        const selectedExclusions = intent.kind === "select_design"
          ? intent.excludedTemplateIds
          : uniqueTemplateIds([...priorExclusions, ...(currentTemplateId ? [currentTemplateId] : [])]);
        const evidence = await dependencies.buildEvidence(input.shopId);
        designResolution = dependencies.resolveDesign({
          prompt: intent.prompt,
          excludedTemplateIds: selectedExclusions,
        }, evidence);
        nextExclusions = selectedExclusions;
        if (designResolution.kind === "no_match") {
          return ready(input, unchanged("No other approved design is available, so your draft was left unchanged."));
        }
        if (designResolution.kind !== "recipe") {
          throw new StoreCommandError("storefront_command_unavailable", "No approved storefront design is available.", 503);
        }
        const recipe = await loadSelectedRecipe(designResolution, dependencies);
        nextBundle = recipe.bundle;
      } else {
        if (!currentTemplateId) {
          return ready(input, unchanged("That change is not available for this storefront yet."));
        }
        nextBundle = dependencies.applyIntent(
          state.draft.bundle,
          getStoreTemplate(currentTemplateId),
          intent,
        ).bundle;
        if (sameBundle(nextBundle, state.draft.bundle)) {
          return ready(input, unchanged("That request did not change the storefront."));
        }
      }
    }

    await emit(input, { stage: "preparing_products" });
    const validation = dependencies.validate(nextBundle);
    if (!validation.ok) {
      throw new StoreCommandError(
        "storefront_command_invalid",
        "That change did not pass storefront validation. Your current draft was not changed.",
        422,
        validation.diagnostics,
      );
    }
    proofContext ??= await dependencies.loadContext({ shopId: input.shopId, prompt: input.command.prompt });
    throwIfAborted(input.signal);
    await emit(input, { stage: "checking_preview" });
    const browserProof = await dependencies.prove({
      bundle: nextBundle,
      context: proofContext,
      persistedAssets: [],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfAborted(input.signal);
    if (!browserProof.ok) {
      throw new StoreCommandError(
        "storefront_command_proof_failed",
        "That change did not pass preview checks. Your current draft was not changed.",
        422,
        browserProof.diagnostics,
      );
    }

    const versionArtifact = artifact(nextBundle);
    if (nextBundle.source.kind !== "recipe") {
      throw new StoreCommandError("storefront_command_unavailable", "This storefront draft cannot be changed with chat yet.", 503);
    }
    const resultArtifactHash = await dependencies.hashArtifact({
      schemaVersion: nextBundle.schemaVersion,
      runtimeVersion: nextBundle.runtimeVersion,
      validationProfileVersion: nextBundle.validationProfileVersion,
      artifact: versionArtifact,
      assetManifest: nextBundle.assets as unknown as Record<string, unknown>,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfAborted(input.signal);
    const internalOperation = operationAudit(intent, designResolution);
    const versionId = await dependencies.createVersion({
      shopId: input.shopId,
      sourceKind: "recipe",
      templateId: nextBundle.source.templateId,
      templateVersion: nextBundle.source.templateVersion,
      status: "validated",
      schemaVersion: nextBundle.schemaVersion,
      runtimeVersion: nextBundle.runtimeVersion,
      validationProfileVersion: nextBundle.validationProfileVersion,
      artifact: versionArtifact,
      assetManifest: nextBundle.assets as unknown as Record<string, unknown>,
      validationReport: { valid: true, static: validation, browserProof },
      generationPrompt: input.command.prompt,
      resolution: {
        operation: internalOperation,
        excludedTemplateIds: nextExclusions,
        ...(designResolution ? { designResolution } : {}),
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!state.draft) {
      throwIfAborted(input.signal);
      await dependencies.install({
        shopId: input.shopId,
        versionId,
        expectedDraftVersionId: input.command.expectedDraftVersionId,
        actorId,
      });
      return ready(input, { status: "installed", versionId, undo: null });
    }

    const expectedDraftVersionId = input.command.expectedDraftVersionId;
    if (!expectedDraftVersionId) {
      throw new StoreCommandError("storefront_command_conflict", "The storefront draft changed before this request.", 409);
    }
    throwIfAborted(input.signal);
    await dependencies.edit({
      shopId: input.shopId,
      baseVersionId: expectedDraftVersionId,
      resultVersionId: versionId,
      expectedDraftVersionId,
      actorId,
      baseArtifactHash: state.draft.artifactHash,
      resultArtifactHash,
      prompt: input.command.prompt,
      scope: { operation: internalOperation, excludedTemplateIds: nextExclusions },
      patch: { operation: internalOperation },
      provider: { kind: "bounded_classification" },
      validation: { static: validation, browserProof },
    });
    return ready(input, {
      status: "installed",
      versionId,
      undo: { targetVersionId: expectedDraftVersionId, expectedDraftVersionId: versionId },
    });
  } catch (error) {
    const failure = normalizedError(error, input.signal);
    await emit(input, {
      stage: "error",
      code: failure.code,
      status: failure.status,
      message: failure.message,
    });
    throw failure;
  }
}
