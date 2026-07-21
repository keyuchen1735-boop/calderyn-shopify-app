import type { StoreTemplateId } from "../storefront-bundle/types";
import { ATELIER_GRID_RECIPE } from "./atelier-nine/bundle";
import { BROADCAST_PATCH_BAY_RECIPE } from "./broadcast-patch-bay/bundle";
import { COMMONS_INDEX_RECIPE } from "./commons-index/bundle";
import { COMPANION_FIELD_GUIDE_RECIPE } from "./companion-field-guide/bundle";
import { CUSTOM_BENCH_RECIPE } from "./custom-bench/bundle";
import { DAILY_PROTOCOL_RECIPE } from "./daily-protocol/bundle";
import { DIAGNOSTIC_DECK_RECIPE } from "./diagnostic-deck/bundle";
import type { DefinedRecipe } from "./factory";
import { LARDER_RECIPE } from "./larder/bundle";
import { REP_REST_RECIPE } from "./rep-rest/bundle";
import { RITUAL_ALMANAC_RECIPE } from "./ritual-almanac/bundle";
import { ROOM_MODES_RECIPE } from "./room-modes/bundle";
import { SOFT_CHEMISTRY_RECIPE } from "./soft-chemistry/bundle";

export const STOREFRONT_RECIPES = [
  CUSTOM_BENCH_RECIPE,
  COMMONS_INDEX_RECIPE,
  SOFT_CHEMISTRY_RECIPE,
  COMPANION_FIELD_GUIDE_RECIPE,
  DAILY_PROTOCOL_RECIPE,
  ROOM_MODES_RECIPE,
  REP_REST_RECIPE,
  DIAGNOSTIC_DECK_RECIPE,
  RITUAL_ALMANAC_RECIPE,
  BROADCAST_PATCH_BAY_RECIPE,
  ATELIER_GRID_RECIPE,
  LARDER_RECIPE,
] as const satisfies readonly DefinedRecipe[];

export const STOREFRONT_RECIPE_BY_ID = Object.fromEntries(
  STOREFRONT_RECIPES.map((recipe) => [recipe.config.templateId, recipe]),
) as Readonly<Record<StoreTemplateId, DefinedRecipe>>;

export function getStorefrontRecipe(templateId: StoreTemplateId): DefinedRecipe {
  return STOREFRONT_RECIPE_BY_ID[templateId];
}
