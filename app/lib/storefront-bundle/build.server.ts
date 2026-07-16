import { getSupabase } from "~/lib/supabase.server";
import { validateCompiledBundle, type BundleValidationReport } from "~/lib/storefront-compiler/validate";
import type { DefinedRecipe } from "~/lib/storefront-recipes/factory";
import { assembleStorefrontContext } from "~/lib/storefront-ai/context.server";
import type {
  BrowserProofReport,
  MerchantStorefrontContext,
  MerchantReferenceImage,
} from "~/lib/storefront-ai/contracts";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";
import { storefrontAiBrowserProof } from "~/lib/storefront-validation/browser.server";
import { STORE_TEMPLATE_REGISTRY } from "./registry";
import { buildCatalogRoutingEvidence } from "./routing-evidence.server";
import { resolveStoreDesign } from "./routing";
import {
  assertStorefrontWriteAllowed,
  createStorefrontBundleVersion,
  installStorefrontDraft,
  type CreateStorefrontBundleVersionInput,
  type InstallStorefrontDraftInput,
} from "./release.server";
import type {
  CatalogRoutingEvidence,
  StoreDesignRequest,
  StoreDesignResolution,
  StorefrontBundleV1,
  StoreTemplateId,
} from "./types";

export interface StorefrontReleasePointers {
  draftVersionId: string | null;
  publishedVersionId: string | null;
}

export interface StorefrontReleaseState extends StorefrontReleasePointers {
  draftRuntimeVersion: number | null;
  publishedRuntimeVersion: number | null;
}

export interface StorefrontBuildReceipt {
  runtime: 1;
  versionId: string;
  status: "draft";
}

export type StorefrontBuildEvent =
  | {
      stage: "routing";
      recommendationChanged: boolean;
      recommendationChangeReason?: string;
    }
  | { stage: "applying_recipe" }
  | { stage: "compiling" | "validating" | "proofing" }
  | { stage: "installed"; receipt: StorefrontBuildReceipt };

export class StorefrontBuildError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "StorefrontBuildError";
  }
}

export interface StorefrontRecipeArtifact {
  bundle: StorefrontBundleV1;
  report: BundleValidationReport;
}

export interface StorefrontBuildDependencies {
  buildEvidence(shopId: string): Promise<CatalogRoutingEvidence>;
  resolveDesign(request: StoreDesignRequest, evidence: CatalogRoutingEvidence): StoreDesignResolution;
  loadRecipe(templateId: StoreTemplateId, templateVersion: number): Promise<StorefrontRecipeArtifact>;
  assertWriteAllowed(shopId: string): Promise<void>;
  readPointers(shopId: string): Promise<StorefrontReleasePointers>;
  createVersion(input: CreateStorefrontBundleVersionInput): Promise<string>;
  installDraft(input: InstallStorefrontDraftInput): Promise<string>;
  validate(bundle: StorefrontBundleV1): BundleValidationReport;
  loadProofContext(input: { shopId: string; prompt: string }): Promise<MerchantStorefrontContext>;
  prove(input: {
    bundle: StorefrontBundleV1;
    context: MerchantStorefrontContext;
    persistedAssets: [];
    signal?: AbortSignal;
  }): Promise<BrowserProofReport>;
}

function enabled(value: string | undefined): boolean {
  return /^(?:1|true)$/i.test(value ?? "");
}

export function isStorefrontRecipeBuildEnabled(value = process.env.STOREFRONT_RECIPE_BUILD): boolean {
  return enabled(value);
}

export function isStorefrontBundlePublishEnabled(value = process.env.STOREFRONT_BUNDLE_PUBLISH): boolean {
  return enabled(value);
}

export function isStorefrontCustomBuildEnabled(value = process.env.STOREFRONT_CUSTOM_BUILD): boolean {
  return enabled(value);
}

export async function readStorefrontReleasePointers(shopId: string): Promise<StorefrontReleasePointers> {
  const result = await getSupabase()
    .from("storefront_release")
    .select("draft_version_id, published_version_id")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (result.error) throw result.error;
  return {
    draftVersionId: typeof result.data?.draft_version_id === "string" ? result.data.draft_version_id : null,
    publishedVersionId: typeof result.data?.published_version_id === "string" ? result.data.published_version_id : null,
  };
}

export async function readStorefrontReleaseState(shopId: string): Promise<StorefrontReleaseState> {
  const pointers = await readStorefrontReleasePointers(shopId);
  const ids = [...new Set([pointers.draftVersionId, pointers.publishedVersionId].filter((id): id is string => id !== null))];
  if (ids.length === 0) return { ...pointers, draftRuntimeVersion: null, publishedRuntimeVersion: null };
  const result = await getSupabase()
    .from("storefront_bundle_version")
    .select("id, runtime_version")
    .eq("shop_id", shopId)
    .in("id", ids);
  if (result.error) throw result.error;
  const runtimes = new Map(
    (result.data ?? []).map((row) => [String(row.id), Number(row.runtime_version)]),
  );
  for (const id of ids) {
    if (!runtimes.has(id)) {
      throw new StorefrontBuildError(
        "storefront_release_pointer_invalid",
        "The storefront release points to a missing version.",
        500,
      );
    }
  }
  return {
    ...pointers,
    draftRuntimeVersion: pointers.draftVersionId ? runtimes.get(pointers.draftVersionId)! : null,
    publishedRuntimeVersion: pointers.publishedVersionId ? runtimes.get(pointers.publishedVersionId)! : null,
  };
}

export async function loadStorefrontRecipe(templateId: StoreTemplateId, templateVersion: number): Promise<DefinedRecipe> {
  let recipe: DefinedRecipe;
  switch (templateId) {
    case "custom-bench":
      recipe = (await import("~/lib/storefront-recipes/custom-bench/bundle")).CUSTOM_BENCH_RECIPE;
      break;
    case "commons-index":
      recipe = (await import("~/lib/storefront-recipes/commons-index/bundle")).COMMONS_INDEX_RECIPE;
      break;
    case "soft-chemistry":
      recipe = (await import("~/lib/storefront-recipes/soft-chemistry/bundle")).SOFT_CHEMISTRY_RECIPE;
      break;
    case "companion-field-guide":
      recipe = (await import("~/lib/storefront-recipes/companion-field-guide/bundle")).COMPANION_FIELD_GUIDE_RECIPE;
      break;
    case "daily-protocol":
      recipe = (await import("~/lib/storefront-recipes/daily-protocol/bundle")).DAILY_PROTOCOL_RECIPE;
      break;
    case "room-modes":
      recipe = (await import("~/lib/storefront-recipes/room-modes/bundle")).ROOM_MODES_RECIPE;
      break;
    case "rep-rest":
      recipe = (await import("~/lib/storefront-recipes/rep-rest/bundle")).REP_REST_RECIPE;
      break;
    case "diagnostic-deck":
      recipe = (await import("~/lib/storefront-recipes/diagnostic-deck/bundle")).DIAGNOSTIC_DECK_RECIPE;
      break;
    case "ritual-almanac":
      recipe = (await import("~/lib/storefront-recipes/ritual-almanac/bundle")).RITUAL_ALMANAC_RECIPE;
      break;
    case "broadcast-patch-bay":
      recipe = (await import("~/lib/storefront-recipes/broadcast-patch-bay/bundle")).BROADCAST_PATCH_BAY_RECIPE;
      break;
    case "atelier-nine":
      recipe = (await import("~/lib/storefront-recipes/atelier-nine/bundle")).ATELIER_GRID_RECIPE;
      break;
  }
  if (recipe.bundle.source.kind !== "recipe" || recipe.bundle.source.templateVersion !== templateVersion) {
    throw new StorefrontBuildError(
      "storefront_recipe_version_unavailable",
      "That storefront recipe version is not available.",
      409,
    );
  }
  return recipe;
}

const defaultDependencies: StorefrontBuildDependencies = {
  buildEvidence: buildCatalogRoutingEvidence,
  resolveDesign: (request, evidence) => resolveStoreDesign(request, evidence, STORE_TEMPLATE_REGISTRY),
  loadRecipe: loadStorefrontRecipe,
  assertWriteAllowed: assertStorefrontWriteAllowed,
  readPointers: readStorefrontReleasePointers,
  createVersion: createStorefrontBundleVersion,
  installDraft: installStorefrontDraft,
  validate: validateCompiledBundle,
  loadProofContext: assembleStorefrontContext,
  prove: storefrontAiBrowserProof,
};

export interface StorefrontBuildInput {
  shopId: string;
  actorId?: string | null;
  request: StoreDesignRequest;
  recommendedResolution?: StoreDesignResolution;
  recipeBuildEnabled?: boolean;
  customBuildEnabled?: boolean;
  trusted?: boolean;
  referenceImages?: MerchantReferenceImage[];
  /** Merchant's design-model picker key, honored only on the custom path. */
  designModel?: StudioDesignModel;
  onEvent?: (event: StorefrontBuildEvent) => void | Promise<void>;
  signal?: AbortSignal;
  prepared?: PreparedStorefrontDesignBuild;
}

function throwIfBuildAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new StorefrontBuildError(
      "generation_cancelled",
      "Storefront generation was stopped. Your current draft was not changed.",
      409,
    );
  }
}

export interface PreparedStorefrontDesignBuild {
  request: StoreDesignRequest;
  evidence: CatalogRoutingEvidence;
  resolution: StoreDesignResolution;
  pointers: StorefrontReleasePointers;
}

/** Resolve and reject every switch/write guard before a streaming response is
 * committed. The returned decision is then consumed by buildStorefrontDesign,
 * so routing is frozen once rather than recomputed across the stream boundary. */
export async function prepareStorefrontDesignBuild(
  input: Pick<StorefrontBuildInput, "shopId" | "request" | "recipeBuildEnabled" | "customBuildEnabled" | "trusted">,
  dependencies: StorefrontBuildDependencies = defaultDependencies,
): Promise<PreparedStorefrontDesignBuild> {
  const evidence = await dependencies.buildEvidence(input.shopId);
  await dependencies.assertWriteAllowed(input.shopId);
  const pointers = await dependencies.readPointers(input.shopId);
  const request = input.request;
  const resolution = dependencies.resolveDesign(request, evidence);
  if (resolution.kind === "recipe" && !(input.recipeBuildEnabled ?? isStorefrontRecipeBuildEnabled())) {
    throw new StorefrontBuildError(
      "storefront_recipe_build_disabled",
      "Recipe storefront builds are temporarily disabled. Your current draft was not changed.",
      503,
    );
  }
  if (resolution.kind === "no_match") {
    throw new StorefrontBuildError(
      "storefront_design_exhausted",
      "No approved storefront design is available. Your current draft was not changed.",
      409,
    );
  }
  return { request, evidence, resolution, pointers };
}

async function emit(
  callback: ((event: StorefrontBuildEvent) => void | Promise<void>) | undefined,
  event: StorefrontBuildEvent,
): Promise<void> {
  await callback?.(event);
}

/**
 * Freeze one server-authoritative routing decision, instantiate its deploy-time
 * validated recipe, and CAS-install one immutable runtime-1 draft. Merchant
 * catalog values remain live renderer bindings; no AI layout or runtime-0
 * generator participates in this path.
 */
export async function buildStorefrontDesign(
  input: StorefrontBuildInput,
  dependencies: StorefrontBuildDependencies = defaultDependencies,
): Promise<StorefrontBuildReceipt> {
  const prepared = input.prepared ?? await prepareStorefrontDesignBuild(input, dependencies);
  throwIfBuildAborted(input.signal);
  const { request, evidence, resolution: frozenResolution, pointers } = prepared;
  if (frozenResolution.kind !== "recipe") {
    throw new StorefrontBuildError(
      "storefront_design_exhausted",
      "No approved storefront design is available. Your current draft was not changed.",
      409,
    );
  }
  const recommendationChanged = input.recommendedResolution
    ? input.recommendedResolution.catalogFingerprint !== frozenResolution.catalogFingerprint
    : false;
  await emit(input.onEvent, {
    stage: "routing",
    recommendationChanged,
    ...(recommendationChanged
      ? { recommendationChangeReason: "Your catalog changed, so this build uses the latest store recommendation." }
      : {}),
  });

  await emit(input.onEvent, { stage: "applying_recipe" });
  const recipeController = new AbortController();
  const abortRecipe = () => recipeController.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abortRecipe, { once: true });
  // Leave 20 seconds of the one-minute preview target for validation and draft installation.
  const recipeTimer = setTimeout(() => recipeController.abort(), 40_000);
  let recipe: StorefrontRecipeArtifact;
  try {
    recipe = await Promise.race([
      dependencies.loadRecipe(frozenResolution.templateId, frozenResolution.templateVersion),
      new Promise<never>((_resolve, reject) => recipeController.signal.addEventListener("abort", () => reject(
        input.signal?.aborted
          ? new StorefrontBuildError("generation_cancelled", "Storefront generation was stopped. Your current draft was not changed.", 409)
          : new StorefrontBuildError("storefront_recipe_imagery_timeout", "Storefront recipe preparation exceeded the first-preview deadline. Your current draft was not changed.", 504),
      ), { once: true })),
    ]);
  } finally {
    clearTimeout(recipeTimer);
    input.signal?.removeEventListener("abort", abortRecipe);
  }
  throwIfBuildAborted(input.signal);
  if (
    recipe.bundle.source.kind !== "recipe" ||
    recipe.bundle.source.templateId !== frozenResolution.templateId ||
    recipe.bundle.source.templateVersion !== frozenResolution.templateVersion
  ) {
    throw new StorefrontBuildError(
      "storefront_recipe_version_mismatch",
      "The selected recipe did not match the frozen build decision.",
      500,
    );
  }

  await emit(input.onEvent, { stage: "compiling" });
  await emit(input.onEvent, { stage: "validating" });
  const validation = dependencies.validate(recipe.bundle);
  if (!recipe.report.ok || !validation.ok) {
    throw new StorefrontBuildError(
      "storefront_recipe_invalid",
      "The selected recipe failed its validation profile. Your current draft was not changed.",
      500,
    );
  }
  await emit(input.onEvent, { stage: "proofing" });
  const proofContext = await dependencies.loadProofContext({
    shopId: input.shopId,
    prompt: request.prompt.trim() || "Build my store",
  });
  throwIfBuildAborted(input.signal);
  const browserProof = await dependencies.prove({
    bundle: recipe.bundle,
    context: proofContext,
    persistedAssets: [],
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!browserProof.ok) {
    throw new StorefrontBuildError(
      "storefront_recipe_proof_failed",
      "The selected storefront did not pass preview checks. Your current draft was not changed.",
      422,
    );
  }
  throwIfBuildAborted(input.signal);

  const versionId = await dependencies.createVersion({
    shopId: input.shopId,
    sourceKind: "recipe",
    templateId: frozenResolution.templateId,
    templateVersion: frozenResolution.templateVersion,
    status: "validated",
    schemaVersion: recipe.bundle.schemaVersion,
    runtimeVersion: recipe.bundle.runtimeVersion,
    validationProfileVersion: recipe.bundle.validationProfileVersion,
    artifact: { sourceKind: "recipe", bundle: recipe.bundle },
    assetManifest: recipe.bundle.assets as unknown as Record<string, unknown>,
    validationReport: {
      valid: true,
      static: validation,
      browserProof,
    },
    generationPrompt: request.prompt,
    resolution: {
      ...frozenResolution,
      request,
      evidence,
    },
  });
  throwIfBuildAborted(input.signal);
  await dependencies.installDraft({
    shopId: input.shopId,
    versionId,
    expectedDraftVersionId: pointers.draftVersionId,
    actorId: input.actorId ?? null,
  });
  const receipt: StorefrontBuildReceipt = {
    runtime: 1,
    versionId,
    status: "draft",
  };
  await emit(input.onEvent, { stage: "installed", receipt });
  return receipt;
}
