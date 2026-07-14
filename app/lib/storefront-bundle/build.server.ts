import { getSupabase } from "~/lib/supabase.server";
import type { BundleValidationReport } from "~/lib/storefront-compiler/validate";
import type { DefinedRecipe } from "~/lib/storefront-recipes/factory";
import { generateOriginalStorefront } from "~/lib/storefront-ai/generate.server";
import { reserveGenerateQuota } from "~/lib/storegen/guard.server";
import type {
  GenerateOriginalStorefrontInput,
  GenerateOriginalStorefrontResult,
  MerchantReferenceImage,
} from "~/lib/storefront-ai/contracts";
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
  resolution: StoreDesignResolution;
}

export type StorefrontBuildEvent =
  | {
      stage: "routing";
      resolution: StoreDesignResolution;
      recommendationChanged: boolean;
      recommendationChangeReason?: string;
    }
  | { stage: "applying_recipe"; templateId: StoreTemplateId; templateVersion: number }
  | { stage: "generating_original" }
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
  customBuildEnabled(): boolean;
  reserveCustomBuild(input: { shopId: string; prompt: string; trusted: boolean }): Promise<string>;
  generateCustom(input: GenerateOriginalStorefrontInput): Promise<GenerateOriginalStorefrontResult>;
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

async function loadRecipe(templateId: StoreTemplateId, templateVersion: number): Promise<DefinedRecipe> {
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
  loadRecipe,
  assertWriteAllowed: assertStorefrontWriteAllowed,
  readPointers: readStorefrontReleasePointers,
  createVersion: createStorefrontBundleVersion,
  installDraft: installStorefrontDraft,
  customBuildEnabled: isStorefrontCustomBuildEnabled,
  reserveCustomBuild: ({ shopId, prompt, trusted }) => reserveGenerateQuota(shopId, prompt, { trusted }),
  generateCustom: (input) => generateOriginalStorefront(input),
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
  onEvent?: (event: StorefrontBuildEvent) => void | Promise<void>;
  prepared?: PreparedStorefrontDesignBuild;
}

export interface PreparedStorefrontDesignBuild {
  evidence: CatalogRoutingEvidence;
  resolution: StoreDesignResolution;
  pointers: StorefrontReleasePointers;
  customQuotaReservationToken?: string;
}

/** Resolve and reject every switch/write guard before a streaming response is
 * committed. The returned decision is then consumed by buildStorefrontDesign,
 * so routing is frozen once rather than recomputed across the stream boundary. */
export async function prepareStorefrontDesignBuild(
  input: Pick<StorefrontBuildInput, "shopId" | "request" | "recipeBuildEnabled" | "customBuildEnabled" | "trusted">,
  dependencies: StorefrontBuildDependencies = defaultDependencies,
): Promise<PreparedStorefrontDesignBuild> {
  const evidence = await dependencies.buildEvidence(input.shopId);
  const resolution = dependencies.resolveDesign(input.request, evidence);
  if (resolution.kind === "recipe" && !(input.recipeBuildEnabled ?? isStorefrontRecipeBuildEnabled())) {
    throw new StorefrontBuildError(
      "storefront_recipe_build_disabled",
      "Recipe storefront builds are temporarily disabled. Your current draft was not changed.",
      503,
    );
  }
  if (resolution.kind === "custom" && !(input.customBuildEnabled ?? dependencies.customBuildEnabled())) {
    throw new StorefrontBuildError(
      "storefront_custom_build_disabled",
      "Original AI storefront generation is not available right now. Your current draft was not changed.",
      503,
    );
  }
  await dependencies.assertWriteAllowed(input.shopId);
  const pointers = await dependencies.readPointers(input.shopId);
  const customQuotaReservationToken = resolution.kind === "custom"
    ? await dependencies.reserveCustomBuild({ shopId: input.shopId, prompt: input.request.prompt, trusted: input.trusted ?? false })
    : undefined;
  return { evidence, resolution, pointers, ...(customQuotaReservationToken ? { customQuotaReservationToken } : {}) };
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
  const { evidence, resolution: frozenResolution, pointers, customQuotaReservationToken } = prepared;
  const recommendationChanged = input.recommendedResolution
    ? input.recommendedResolution.catalogFingerprint !== frozenResolution.catalogFingerprint
    : false;
  await emit(input.onEvent, {
    stage: "routing",
    resolution: frozenResolution,
    recommendationChanged,
    ...(recommendationChanged
      ? { recommendationChangeReason: "Your catalog changed, so this build uses the latest store recommendation." }
      : {}),
  });

  if (frozenResolution.kind === "custom") {
    await emit(input.onEvent, { stage: "generating_original" });
    const generated = await dependencies.generateCustom({
      shopId: input.shopId,
      prompt: input.request.prompt,
      expectedDraftVersionId: pointers.draftVersionId,
      actorId: input.actorId ?? null,
      trusted: input.trusted ?? false,
      routingResolution: frozenResolution,
      ...(customQuotaReservationToken ? { quotaReservationToken: customQuotaReservationToken } : {}),
      ...(input.referenceImages ? { referenceImages: input.referenceImages } : {}),
    });
    if (generated.status === "disabled") {
      throw new StorefrontBuildError(generated.code, "Original AI storefront generation is not available right now. Your current draft was not changed.", 503);
    }
    if (generated.status === "cancelled") {
      throw new StorefrontBuildError(generated.code, "Original storefront generation was cancelled. Your current draft was not changed.", 409);
    }
    if (generated.status === "failed") {
      throw new StorefrontBuildError(
        generated.code,
        generated.code === "generation_budget_exceeded"
          ? "Original storefront generation reached its build limit. Your current draft was not changed."
          : "Original storefront generation failed. Your current draft was not changed.",
        generated.code === "generation_budget_exceeded" ? 429 : 502,
      );
    }
    const receipt: StorefrontBuildReceipt = {
      runtime: 1,
      versionId: generated.versionId,
      status: "draft",
      resolution: frozenResolution,
    };
    await emit(input.onEvent, { stage: "installed", receipt });
    return receipt;
  }
  await emit(input.onEvent, {
    stage: "applying_recipe",
    templateId: frozenResolution.templateId,
    templateVersion: frozenResolution.templateVersion,
  });
  const recipe = await dependencies.loadRecipe(frozenResolution.templateId, frozenResolution.templateVersion);
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
  if (!recipe.report.ok) {
    throw new StorefrontBuildError(
      "storefront_recipe_invalid",
      "The selected recipe failed its validation profile. Your current draft was not changed.",
      500,
    );
  }
  await emit(input.onEvent, { stage: "proofing" });

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
      ...recipe.report,
      proofKind: "deploy_time_recipe_matrix",
    },
    generationPrompt: input.request.prompt,
    resolution: {
      ...frozenResolution,
      request: input.request,
      evidence,
    },
  });
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
    resolution: frozenResolution,
  };
  await emit(input.onEvent, { stage: "installed", receipt });
  return receipt;
}
