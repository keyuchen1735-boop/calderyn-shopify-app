import { getSupabase } from "~/lib/supabase.server";
import type { DefinedRecipe } from "~/lib/storefront-recipes/factory";
import type { StoreTemplateId } from "./types";

export interface StorefrontReleasePointers {
  draftVersionId: string | null;
  publishedVersionId: string | null;
}

export interface StorefrontReleaseState extends StorefrontReleasePointers {
  draftRuntimeVersion: number | null;
  publishedRuntimeVersion: number | null;
}

export type StorefrontRecipeArtifact = DefinedRecipe;

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

function enabled(value: string | undefined): boolean {
  return /^(?:1|true)$/i.test(value ?? "");
}

export function isStorefrontRecipeBuildEnabled(value = process.env.STOREFRONT_RECIPE_BUILD): boolean {
  return enabled(value);
}

export function isStorefrontBundlePublishEnabled(value = process.env.STOREFRONT_BUNDLE_PUBLISH): boolean {
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
  const runtimes = new Map((result.data ?? []).map((row) => [String(row.id), Number(row.runtime_version)]));
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
    default:
      throw new StorefrontBuildError(
        "storefront_recipe_version_unavailable",
        "That storefront recipe version is not available.",
        409,
      );
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
