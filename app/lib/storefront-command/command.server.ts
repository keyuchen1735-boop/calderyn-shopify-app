import { getSupabase } from "~/lib/supabase.server";
import {
  STOREFRONT_REFERENCE_MEDIA_TYPES,
  type BrowserProofReport,
  type ContextAssemblyInput,
  type MerchantReferenceImage,
  type MerchantStorefrontContext,
  type StorefrontReferenceMediaType,
} from "~/lib/storefront-ai/contracts";
import {
  assembleStorefrontContextWithReferences,
  type StorefrontContextAssembly,
} from "~/lib/storefront-ai/context.server";
import {
  compileAuthoring,
  parseStorefrontVersionArtifact,
  type StorefrontVersionArtifactV1,
} from "~/lib/storefront-ai/authoring.server";
import {
  runStorefrontRedesign,
  type RunStorefrontRedesignInput,
  type StorefrontRedesignResult,
} from "~/lib/storefront-ai/redesign.server";
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
  installStorefrontCustomRedesign,
  installStorefrontDraft,
  publishStorefrontRelease,
  StorefrontReleaseError,
  type CreateStorefrontBundleVersionInput,
  type EditStorefrontDraftInput,
  type HashStorefrontArtifactInput,
  type InstallStorefrontCustomRedesignInput,
  type InstallStorefrontDraftInput,
  type PublishStorefrontReleaseInput,
} from "~/lib/storefront-bundle/release.server";
import { buildCatalogRoutingEvidence } from "~/lib/storefront-bundle/routing-evidence.server";
import {
  explicitStoreTemplateExclusions,
  resolveStoreDesign,
} from "~/lib/storefront-bundle/routing";
import type {
  CatalogRoutingEvidence,
  StoreDesignRequest,
  StoreDesignResolution,
  StorefrontBundleV1,
  StorefrontRouteId,
  StoreTemplateId,
  VersionedStoreTemplate,
} from "~/lib/storefront-bundle/types";
import { validateCompiledBundle, type BundleValidationReport } from "~/lib/storefront-compiler/validate";
import { StorefrontUndoError, undoStorefrontEdit } from "~/lib/storefront-edit/undo.server";
import { isStorefrontBundleReadEnabled } from "~/lib/storefront-runtime/csp.server";
import { requirePublishableTenantDomain } from "~/lib/storebuilder/studio.server";
import { getPreviewCatalog } from "~/lib/storefront/catalog.server";
import { generateMissingListingImages } from "~/lib/storegen/imagery/asset.server";
import { storefrontAiBrowserProof } from "~/lib/storefront-validation/browser.server";
import { applyStoreIntent } from "./apply";
import { classifyStoreIntent, type StoreIntentClassificationOptions } from "./intent.server";
import {
  STORE_COMMAND_LIMITS,
  type StoreAttachment,
  type StoreCommand,
  type StoreCommandEvent,
  type StoreCommandReceipt,
  type StoreIntent,
} from "./types";

const PRODUCTLESS_PROOF_ROUTES = ["home", "collection", "search", "cart", "checkout"] as const satisfies readonly StorefrontRouteId[];

export interface LoadedStoreCommandVersion {
  versionId: string;
  artifactHash: string;
  artifact?: StorefrontVersionArtifactV1;
  bundle: StorefrontBundleV1;
  resolution: Record<string, unknown>;
}

export interface StoreCommandState {
  draft: LoadedStoreCommandVersion | null;
  publishedVersionId: string | null;
}

export interface VerifiedDesignReferenceImage {
  assetKey: string;
  publicUrl: string;
  mediaType: StorefrontReferenceMediaType;
}

export interface StoreCommandDependencies {
  loadState(shopId: string): Promise<StoreCommandState>;
  assertWriteAllowed(shopId: string): Promise<void>;
  assertPublishable(shopId: string): Promise<void>;
  readEnabled(): boolean;
  recipeBuildEnabled(): boolean;
  publishEnabled(): boolean;
  customRedesignEnabled(): boolean;
  buildEvidence(shopId: string): Promise<CatalogRoutingEvidence>;
  loadReferenceImages(shopId: string, assetRefs: readonly string[]): Promise<VerifiedDesignReferenceImage[]>;
  loadContext(input: ContextAssemblyInput): Promise<StorefrontContextAssembly>;
  prepareProductMedia(shopId: string, signal?: AbortSignal): Promise<number>;
  classify(
    input: Parameters<typeof classifyStoreIntent>[0],
    options?: StoreIntentClassificationOptions,
  ): Promise<StoreIntent>;
  resolveDesign(request: StoreDesignRequest, evidence: CatalogRoutingEvidence): StoreDesignResolution;
  loadRecipe(templateId: StoreTemplateId, templateVersion: number): Promise<StorefrontRecipeArtifact>;
  applyIntent(bundle: StorefrontBundleV1, template: VersionedStoreTemplate, intent: StoreIntent): { bundle: StorefrontBundleV1 };
  validate(bundle: StorefrontBundleV1): BundleValidationReport;
  prove(input: {
    bundle: StorefrontBundleV1;
    context: MerchantStorefrontContext;
    persistedAssets: [];
    routes?: readonly StorefrontRouteId[];
    signal?: AbortSignal;
  }): Promise<BrowserProofReport>;
  redesign(input: RunStorefrontRedesignInput): Promise<StorefrontRedesignResult>;
  installRedesign(input: InstallStorefrontCustomRedesignInput): Promise<string>;
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

function validReferenceUrl(value: unknown): value is string {
  if (typeof value !== "string" || Array.from(value).length > 2_048) return false;
  try { return new URL(value).protocol === "https:"; }
  catch { return false; }
}

function referenceMediaType(value: unknown): StorefrontReferenceMediaType | null {
  return typeof value === "string"
    && STOREFRONT_REFERENCE_MEDIA_TYPES.includes(value as StorefrontReferenceMediaType)
    ? value as StorefrontReferenceMediaType
    : null;
}

export async function loadVerifiedDesignReferenceImages(
  shopId: string,
  assetRefs: readonly string[],
): Promise<VerifiedDesignReferenceImage[]> {
  if (assetRefs.length > STORE_COMMAND_LIMITS.designReferences) {
    throw new StoreCommandError("storefront_command_invalid", "Too many design references were attached.", 422);
  }
  const supabase = getSupabase();
  return Promise.all(assetRefs.map(async (assetRef) => {
    const result = await supabase
      .from("asset_dim")
      .select("shop_id, storage_key, public_url, mime")
      .eq("shop_id", shopId)
      .eq("storage_key", assetRef)
      .maybeSingle();
    if (result.error) throw result.error;
    const row = result.data as {
      shop_id?: unknown;
      storage_key?: unknown;
      public_url?: unknown;
      mime?: unknown;
    } | null;
    const mediaType = referenceMediaType(row?.mime);
    if (!row || row.shop_id !== shopId || row.storage_key !== assetRef
      || !validReferenceUrl(row.public_url) || !mediaType) {
      throw new StoreCommandError(
        "storefront_command_invalid",
        "That design reference is not owned by this store.",
        422,
      );
    }
    return { assetKey: assetRef, publicUrl: row.public_url, mediaType };
  }));
}

function isBundle(value: unknown): value is StorefrontBundleV1 {
  return Boolean(value) && typeof value === "object" && (value as StorefrontBundleV1).runtimeVersion === 1;
}

function extractBundle(value: unknown): StorefrontBundleV1 | null {
  if (!value || typeof value !== "object") return null;
  const artifact = value as Record<string, unknown>;
  return isBundle(artifact.bundle) ? artifact.bundle : isBundle(value) ? value : null;
}

export function parseLoadedStorefrontArtifact(value: unknown): StorefrontVersionArtifactV1 | null {
  const bundle = extractBundle(value);
  if (!bundle) return null;
  const stored = value as Record<string, unknown>;
  try {
    return parseStorefrontVersionArtifact(
      "sourceKind" in stored ? stored : { sourceKind: bundle.source.kind, bundle },
    );
  } catch {
    return null;
  }
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
  const artifact = parseLoadedStorefrontArtifact(row?.bundle_json);
  if (!row || row.status !== "validated" || Number(row.runtime_version) !== 1 || !artifact) {
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
      artifact,
      bundle: artifact.bundle,
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
  customRedesignEnabled: () => process.env.STOREFRONT_CUSTOM_REDESIGN === "1",
  buildEvidence: buildCatalogRoutingEvidence,
  loadReferenceImages: loadVerifiedDesignReferenceImages,
  loadContext: assembleStorefrontContextWithReferences,
  prepareProductMedia: async (shopId, signal) => {
    const products = await getPreviewCatalog().listProducts(shopId);
    return generateMissingListingImages(shopId, products, undefined, signal);
  },
  classify: (input, options) => classifyStoreIntent(input, {}, options),
  resolveDesign: (request, evidence) => resolveStoreDesign(request, evidence, STORE_TEMPLATE_REGISTRY),
  loadRecipe: loadStorefrontRecipe,
  applyIntent: applyStoreIntent,
  validate: validateCompiledBundle,
  prove: storefrontAiBrowserProof,
  redesign: runStorefrontRedesign,
  installRedesign: installStorefrontCustomRedesign,
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
  if (code === "invalid_store_intent") {
    return new StoreCommandError(
      "storefront_command_rejected",
      "I couldn't act on that request as written. Try one change at a time, like \"make the hero warmer\" or just \"build my store\". Your current draft was not changed.",
      422,
    );
  }
  if (code === "storefront_command_invalid" || code === "storefront_command_proof_failed") {
    return new StoreCommandError(
      "storefront_command_rejected",
      "That storefront change could not be applied safely. Your current draft was not changed.",
      422,
    );
  }
  if (code.startsWith("storefront_redesign_")) {
    return new StoreCommandError(
      code.endsWith("cancelled") ? "generation_cancelled" : "storefront_command_rejected",
      code.endsWith("cancelled")
        ? "Storefront generation was stopped. Your current draft was not changed."
        : "That storefront change could not be applied safely. Your current draft was not changed.",
      code.endsWith("cancelled") ? 409 : 422,
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

function designReferenceRefs(attachments?: readonly StoreAttachment[]): string[] {
  return (attachments ?? [])
    .filter((attachment): attachment is Extract<StoreAttachment, { kind: "design_reference" }> =>
      attachment.kind === "design_reference")
    .map(({ assetRef }) => assetRef);
}

const ATTACHED_SHADER_COLORS: [string, string, string] = ["#000000", "#ffffff", "#888888"];

function attachedShader(attachments?: readonly StoreAttachment[]): Extract<StoreAttachment, { kind: "fragment_shader" }> | null {
  return attachments?.find((attachment): attachment is Extract<StoreAttachment, { kind: "fragment_shader" }> =>
    attachment.kind === "fragment_shader") ?? null;
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

function ownedProductId(reference: string, assembly: StorefrontContextAssembly): string {
  const product = assembly.references.products[reference];
  if (!product) {
    throw new StoreCommandError(
      "storefront_command_invalid",
      "That product selection could not be resolved safely.",
      422,
    );
  }
  return product.id;
}

function proofContext(
  assembly: StorefrontContextAssembly,
  requiredProductIds: readonly string[],
): MerchantStorefrontContext {
  const context = {
    ...assembly.context,
    products: assembly.context.products.map((product) => ({
      ...product,
      id: ownedProductId(product.id, assembly),
    })),
  };
  const availableIds = new Set(context.products.map(({ id }) => id));
  if (requiredProductIds.some((id) => !availableIds.has(id))) {
    throw new StoreCommandError(
      "storefront_command_invalid",
      "That product selection could not be resolved safely.",
      422,
    );
  }
  return context;
}

function hasOwnedProducts(assembly: StorefrontContextAssembly, productIds: readonly string[]): boolean {
  const availableIds = new Set(Object.values(assembly.references.products).map(({ id }) => id));
  return productIds.every((id) => availableIds.has(id));
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
    const assetRefs = designReferenceRefs(input.command.attachments);
    const verifiedReferenceImages = assetRefs.length > 0
      ? await dependencies.loadReferenceImages(input.shopId, assetRefs)
      : [];
    throwIfAborted(input.signal);
    const referenceImages: MerchantReferenceImage[] = verifiedReferenceImages
      .map(({ assetKey, mediaType }) => ({ assetKey, mediaType }));
    const classificationAssembly = await dependencies.loadContext({
      shopId: input.shopId,
      prompt: input.command.prompt,
      requiredProductIds: state.draft?.bundle.featuredProductIds ?? [],
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    });
    let contextAssembly: StorefrontContextAssembly | null = classificationAssembly;
    throwIfAborted(input.signal);
    const classificationInput: Parameters<typeof classifyStoreIntent>[0] = {
      prompt: input.command.prompt,
      ...(currentTemplateId ? { currentTemplateId } : {}),
      excludedTemplateIds: priorExclusions,
      ...(state.draft ? { bundle: state.draft.bundle } : {}),
      productCandidates: classificationAssembly.context.products
        .filter(({ title }) => title.trim().length > 0)
        .slice(0, 100)
        .map(({ id, title }) => ({ id, title })),
      ...(input.command.context ? { context: input.command.context } : {}),
      ...(input.command.attachments ? { attachments: input.command.attachments } : {}),
      ...(verifiedReferenceImages.length > 0 ? {
        referenceImages: verifiedReferenceImages.map(({ publicUrl: url, mediaType }) => ({ url, mediaType })),
      } : {}),
    };
    let intent: StoreIntent | null = input.signal
      ? await dependencies.classify(classificationInput, { signal: input.signal })
      : await dependencies.classify(classificationInput);
    throwIfAborted(input.signal);

    if (state.draft?.bundle.source.kind === "custom" && intent.kind === "update_text") {
      if (!input.command.context?.routeId) {
        return ready(input, unchanged("That change needs an active storefront page."));
      }
      intent = { kind: "structural_edit", scope: { routeId: input.command.context.routeId } };
    }

    if (intent.kind === "structural_edit" || intent.kind === "full_redesign") {
      if (!state.draft) {
        return ready(input, unchanged("Build a storefront before redesigning it."));
      }
      if (!dependencies.customRedesignEnabled()) {
        throw new StoreCommandError("storefront_command_unavailable", "Custom storefront redesign is disabled.", 503);
      }
      if (intent.kind === "structural_edit"
        && (!input.command.context?.routeId || intent.scope.routeId !== input.command.context.routeId)) {
        return ready(input, unchanged("That change needs an active storefront page."));
      }
      const baseArtifact = state.draft.artifact
        ?? parseLoadedStorefrontArtifact({ sourceKind: state.draft.bundle.source.kind, bundle: state.draft.bundle });
      if (!baseArtifact) {
        throw new StoreCommandError("storefront_command_unavailable", "This storefront draft has no valid authoring source.", 503);
      }
      const expectedDraftVersionId = input.command.expectedDraftVersionId;
      if (!expectedDraftVersionId || expectedDraftVersionId !== state.draft.versionId) {
        throw new StoreCommandError("storefront_command_conflict", "The storefront draft changed before this request.", 409);
      }
      const recipe = state.draft.bundle.source.kind === "recipe"
        ? await dependencies.loadRecipe(
          state.draft.bundle.source.templateId,
          state.draft.bundle.source.templateVersion,
        )
        : undefined;
      await emit(input, { stage: "planning_redesign" });
      await emit(input, { stage: "building_pages" });
      const result = await dependencies.redesign({
        shopId: input.shopId,
        prompt: input.command.prompt,
        mode: intent.kind,
        ...(intent.kind === "structural_edit" ? { scope: { routeId: input.command.context!.routeId } } : {}),
        baseVersionId: state.draft.versionId,
        baseArtifact,
        ...(recipe ? { recipe } : {}),
        context: classificationAssembly,
        referenceImages: verifiedReferenceImages.map(({ publicUrl: url, mediaType }) => ({ url, mediaType })),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      throwIfAborted(input.signal);
      if (result.artifact.sourceKind !== "custom") {
        throw new StoreCommandError("storefront_command_invalid", "Redesign returned an invalid artifact.", 422);
      }
      const resultArtifactHash = await dependencies.hashArtifact({
        schemaVersion: result.artifact.bundle.schemaVersion,
        runtimeVersion: result.artifact.bundle.runtimeVersion,
        validationProfileVersion: result.artifact.bundle.validationProfileVersion,
        artifact: result.artifact as unknown as Record<string, unknown>,
        assetManifest: result.artifact.bundle.assets as unknown as Record<string, unknown>,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      throwIfAborted(input.signal);
      const versionId = await dependencies.installRedesign({
        shopId: input.shopId,
        actorId,
        baseVersionId: state.draft.versionId,
        expectedDraftVersionId,
        baseArtifactHash: state.draft.artifactHash,
        resultArtifactHash,
        artifact: result.artifact as typeof result.artifact & { sourceKind: "custom" },
        assetManifest: result.artifact.bundle.assets as unknown as Record<string, unknown>,
        schemaVersion: result.artifact.bundle.schemaVersion,
        runtimeVersion: result.artifact.bundle.runtimeVersion,
        validationProfileVersion: result.artifact.bundle.validationProfileVersion,
        validationReport: { valid: true, static: result.validation, browserProof: result.browserProof },
        generationPrompt: input.command.prompt,
        resolution: { kind: "custom_redesign", mode: intent.kind },
        prompt: input.command.prompt,
        scope: { mode: intent.kind, ...(intent.kind === "structural_edit" ? { routeId: input.command.context!.routeId } : {}) },
        patch: { changedRouteIds: result.audit.changedRouteIds, shellChanged: result.audit.shellChanged },
        provider: { calls: result.audit.provider, repairs: result.audit.repairs },
        validation: { static: result.validation, browserProof: result.browserProof },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return ready(input, {
        status: "installed",
        versionId,
        undo: { targetVersionId: expectedDraftVersionId, expectedDraftVersionId: versionId },
      });
    }

    await emit(input, { stage: "preparing_products" });
    await dependencies.prepareProductMedia(input.shopId, input.signal);
    throwIfAborted(input.signal);
    contextAssembly = await dependencies.loadContext({
      shopId: input.shopId,
      prompt: input.command.prompt,
      requiredProductIds: state.draft?.bundle.featuredProductIds ?? [],
      ...(referenceImages.length > 0 ? { referenceImages } : {}),
    });
    throwIfAborted(input.signal);

    if (state.draft?.bundle.source.kind === "custom"
      && (intent.kind === "update_merchandising" || intent.kind === "update_visual_layer")) {
      const expectedDraftVersionId = input.command.expectedDraftVersionId;
      const baseArtifact = state.draft.artifact;
      if (!expectedDraftVersionId || expectedDraftVersionId !== state.draft.versionId) {
        throw new StoreCommandError("storefront_command_conflict", "The storefront draft changed before this request.", 409);
      }
      if (!baseArtifact?.authoring) {
        return ready(input, unchanged("That change is not available for this storefront yet."));
      }
      const authoring = structuredClone(baseArtifact.authoring);
      if (intent.kind === "update_merchandising") {
        authoring.overrides.featuredProductIds = intent.productIds.map((id) => ownedProductId(id, classificationAssembly));
      } else {
        authoring.overrides.visualLayer = structuredClone(intent.visualLayer);
      }
      const compiled = compileAuthoring(authoring);
      if (!compiled.report.ok) {
        throw new StoreCommandError("storefront_command_invalid", "That change did not pass storefront validation.", 422);
      }
      const customArtifact = {
        sourceKind: "custom" as const, bundle: compiled.bundle, authoring,
      };
      const requiredProductIds = compiled.bundle.featuredProductIds ?? [];
      if (!hasOwnedProducts(contextAssembly, requiredProductIds)) {
        contextAssembly = await dependencies.loadContext({
          shopId: input.shopId, prompt: input.command.prompt, requiredProductIds,
          ...(referenceImages.length > 0 ? { referenceImages } : {}),
        });
      }
      await emit(input, { stage: "checking_preview" });
      const browserProof = await dependencies.prove({
        bundle: compiled.bundle,
        context: proofContext(contextAssembly, requiredProductIds),
        persistedAssets: [],
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!browserProof.ok) {
        throw new StoreCommandError("storefront_command_proof_failed", "That change did not pass preview checks.", 422);
      }
      const resultArtifactHash = await dependencies.hashArtifact({
        schemaVersion: compiled.bundle.schemaVersion,
        runtimeVersion: compiled.bundle.runtimeVersion,
        validationProfileVersion: compiled.bundle.validationProfileVersion,
        artifact: customArtifact as unknown as Record<string, unknown>,
        assetManifest: compiled.bundle.assets as unknown as Record<string, unknown>,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const operation = operationAudit(intent, null);
      const versionId = await dependencies.installRedesign({
        shopId: input.shopId, actorId, baseVersionId: state.draft.versionId, expectedDraftVersionId,
        baseArtifactHash: state.draft.artifactHash, resultArtifactHash, artifact: customArtifact,
        assetManifest: compiled.bundle.assets as unknown as Record<string, unknown>,
        schemaVersion: compiled.bundle.schemaVersion, runtimeVersion: compiled.bundle.runtimeVersion,
        validationProfileVersion: compiled.bundle.validationProfileVersion,
        validationReport: { valid: true, static: compiled.report, browserProof },
        generationPrompt: input.command.prompt, resolution: { kind: "custom_deterministic_edit", operation },
        prompt: input.command.prompt, scope: { operation }, patch: { operation },
        provider: { kind: "deterministic" }, validation: { static: compiled.report, browserProof },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return ready(input, {
        status: "installed", versionId,
        undo: { targetVersionId: expectedDraftVersionId, expectedDraftVersionId: versionId },
      });
    }
    let designResolution: StoreDesignResolution | null = null;
    let nextExclusions = priorExclusions;
    let nextBundle: StorefrontBundleV1;

    if (!state.draft) {
      if (intent.kind !== "select_design") {
        return ready(input, unchanged("I couldn't apply that request safely, so your draft was left unchanged."));
      }
      const selectedExclusions = intent.excludedTemplateIds;
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
      if (intent.kind === "unsupported") {
        return ready(input, unchanged("I couldn't apply that request safely, so your draft was left unchanged."));
      }
      if (intent.kind === "select_design" || intent.kind === "start_over") {
        const selectedExclusions = intent.kind === "select_design"
          ? intent.excludedTemplateIds
          : uniqueTemplateIds([
            ...priorExclusions,
            ...(currentTemplateId ? [currentTemplateId] : []),
            ...explicitStoreTemplateExclusions(input.command.prompt, STORE_TEMPLATE_REGISTRY),
          ]);
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
        if (intent.kind === "update_merchandising") {
          intent = {
            ...intent,
            productIds: intent.productIds.map((reference) => ownedProductId(reference, classificationAssembly)),
          };
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

    const shader = attachedShader(input.command.attachments);
    if (shader && designResolution?.kind === "recipe") {
      nextBundle = dependencies.applyIntent(
        nextBundle,
        getStoreTemplate(designResolution.templateId),
        {
          kind: "update_visual_layer",
          visualLayer: { kind: "fragment_shader", source: shader.source, colors: ATTACHED_SHADER_COLORS },
        },
      ).bundle;
    }

    const validation = dependencies.validate(nextBundle);
    if (!validation.ok) {
      throw new StoreCommandError(
        "storefront_command_invalid",
        "That change did not pass storefront validation. Your current draft was not changed.",
        422,
        validation.diagnostics,
      );
    }
    const requiredProductIds = nextBundle.featuredProductIds ?? [];
    if (!contextAssembly || !hasOwnedProducts(contextAssembly, requiredProductIds)) {
      contextAssembly = await dependencies.loadContext({
        shopId: input.shopId,
        prompt: input.command.prompt,
        requiredProductIds,
        ...(referenceImages.length > 0 ? { referenceImages } : {}),
      });
    }
    throwIfAborted(input.signal);
    await emit(input, { stage: "checking_preview" });
    const context = proofContext(contextAssembly, requiredProductIds);
    const browserProof = await dependencies.prove({
      bundle: nextBundle,
      context,
      persistedAssets: [],
      ...(context.products.length === 0 ? { routes: PRODUCTLESS_PROOF_ROUTES } : {}),
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
      artifact: versionArtifact as unknown as Record<string, unknown>,
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
    if (failure.code === "storefront_command_failed") {
      console.error("[storefront-command] unexpected failure", {
        shopId: input.shopId,
        commandKind: input.command.kind,
        error,
      });
    }
    await emit(input, {
      stage: "error",
      code: failure.code,
      status: failure.status,
      message: failure.message,
    });
    throw failure;
  }
}
