import type { StudioVibe } from "./studio-types";
import { STORE_TEMPLATE_REGISTRY } from "~/lib/storefront-bundle/registry";
import type { StoreTemplateId } from "~/lib/storefront-bundle/types";

export type { StoreTemplateId } from "~/lib/storefront-bundle/types";

export interface StoreTemplateRecipe {
  id: StoreTemplateId;
  name: string;
  descriptor: string;
  previewSrc: string;
  vibe: StudioVibe;
  matchTerms: readonly string[];
  generationInstructions: string;
}

const atelier = STORE_TEMPLATE_REGISTRY.templates.find((template) => template.id === "atelier-nine");
if (!atelier) throw new Error("Atelier Grid compatibility recipe is missing");

/** @deprecated Runtime-0 Store Studio adapter. Runtime-1 reads STORE_TEMPLATE_REGISTRY directly. */
export const STORE_TEMPLATE_RECIPES: readonly StoreTemplateRecipe[] = [
  {
    id: atelier.id,
    name: atelier.name,
    descriptor: atelier.descriptor,
    previewSrc: atelier.previewSrc,
    vibe: atelier.legacyVibe,
    matchTerms: [...atelier.promptTerms, ...atelier.catalogTerms],
    generationInstructions: atelier.generationInstructions,
  },
] as const;

function normalizedWords(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function recommendStoreTemplates(prompt: string): StoreTemplateRecipe[] {
  const words = new Set(normalizedWords(prompt));
  return STORE_TEMPLATE_RECIPES.map((recipe, index) => ({
    recipe,
    index,
    score: recipe.matchTerms.reduce((total, term) => total + (words.has(term) ? 1 : 0), 0),
  }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ recipe }) => recipe);
}

export function templateGenerationBrief(recipe: StoreTemplateRecipe, merchantPrompt: string): string {
  const intent = merchantPrompt.trim();
  return [intent ? `Merchant intent: ${intent}` : "", `Visual direction: ${recipe.generationInstructions}`]
    .filter(Boolean)
    .join("\n\n");
}
