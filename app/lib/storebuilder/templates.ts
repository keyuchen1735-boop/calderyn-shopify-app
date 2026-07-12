import type { StudioVibe } from "./studio-types";

export type StoreTemplateId = "atelier-nine";

export interface StoreTemplateRecipe {
  id: StoreTemplateId;
  name: string;
  descriptor: string;
  previewSrc: string;
  vibe: StudioVibe;
  matchTerms: readonly string[];
  generationInstructions: string;
}

export const STORE_TEMPLATE_RECIPES: readonly StoreTemplateRecipe[] = [
  {
    id: "atelier-nine",
    name: "Atelier Grid",
    descriptor: "Editorial / restrained / fashion-led",
    previewSrc: "/template-previews/atelier-nine.webp",
    vibe: "minimal",
    matchTerms: [
      "apparel", "beauty", "clothing", "editorial", "fashion", "jewelry", "luxury", "minimal", "skincare", "studio",
    ],
    generationInstructions:
      "Use an original editorial commerce system: warm-white canvas, black typography, one vermilion accent, asymmetric magazine composition, oversized condensed display type, thin rules, square controls, restrained motion, and image-led product storytelling. Preserve generous negative space and avoid rounded cards, pill buttons, gradients, and centered generic hero layouts.",
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
