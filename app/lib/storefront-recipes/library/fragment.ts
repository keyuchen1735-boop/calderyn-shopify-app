export interface RecipeFragment { html: string; css: string }

export function mergeRecipeFragments(...fragments: readonly RecipeFragment[]): RecipeFragment {
  return { html: fragments.map((item) => item.html).join(""), css: fragments.map((item) => item.css).join("") };
}

export function recipeAttribute(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw new Error("Recipe fragment identifiers must be bounded local names");
  return value;
}

export function recipeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
