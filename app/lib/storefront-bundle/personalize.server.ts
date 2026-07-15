import type { StorefrontAiProvider } from "../storefront-ai/contracts";
import { createAnthropicStructuredProvider } from "../storefront-ai/provider.server";
import { applyStorefrontPatch } from "../storefront-edit/patch.server";
import { patchFitsRecipeOverride } from "../storefront-edit/recipe-override";
import type { StorefrontPatchOperation } from "../storefront-edit/types";
import { validateCompiledBundle, type BundleValidationReport } from "../storefront-compiler/validate";
import type { CatalogRoutingEvidence, CompiledElementNode, CompiledNode, StorefrontBundleV1 } from "./types";

export interface RecipePersonalizationInput {
  recipe: { bundle: StorefrontBundleV1; report: BundleValidationReport };
  prompt: string;
  evidence: CatalogRoutingEvidence;
  signal: AbortSignal;
}

const PERSONALIZATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["accentColor", "backgroundColor", "heroTitle", "heroBody"],
  properties: {
    accentColor: { anyOf: [{ type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, { type: "null" }] },
    backgroundColor: { anyOf: [{ type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, { type: "null" }] },
    heroTitle: { anyOf: [{ type: "string", minLength: 1, maxLength: 120 }, { type: "null" }] },
    heroBody: { anyOf: [{ type: "string", minLength: 1, maxLength: 300 }, { type: "null" }] },
  },
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recipe personalization response is invalid");
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Recipe personalization text is invalid");
  return value.trim();
}

function optionalColor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Recipe personalization color is invalid");
  return value.toLowerCase();
}

function firstLiteral(nodes: readonly CompiledNode[], tag: "h1" | "p", bound: ReadonlySet<string>): CompiledElementNode | null {
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    if (node.tag === tag && !bound.has(node.id) && node.children.some((child) => child.kind === "text")) return node;
    const nested = firstLiteral(node.children, tag, bound);
    if (nested) return nested;
  }
  return null;
}

export async function personalizeStorefrontRecipe(
  input: RecipePersonalizationInput,
  provider?: StorefrontAiProvider,
) {
  if (!input.prompt.trim()) return input.recipe;
  const response = await (provider ?? createAnthropicStructuredProvider()).complete({
    operation: "patch",
    system: "Personalize a fixed storefront recipe. Return only bounded copy and color values. Never propose HTML, CSS, layout, routes, or new sections.",
    prompt: JSON.stringify({ merchantPrompt: input.prompt, catalog: input.evidence }),
    schema: PERSONALIZATION_SCHEMA,
    signal: input.signal,
  });
  const value = record(response.value);
  const accentColor = optionalColor(value.accentColor);
  const backgroundColor = optionalColor(value.backgroundColor);
  const heroTitle = optionalText(value.heroTitle, 120);
  const heroBody = optionalText(value.heroBody, 300);
  const operations: StorefrontPatchOperation[] = [];
  if (accentColor) operations.push({ kind: "setToken", tokenId: "accent", value: accentColor });
  if (backgroundColor) operations.push({ kind: "setToken", tokenId: "background", value: backgroundColor });
  const home = input.recipe.bundle.routes.home;
  const bound = new Set(home.bindings.map((binding) => binding.targetId));
  const title = heroTitle ? firstLiteral(home.tree, "h1", bound) : null;
  const body = heroBody ? firstLiteral(home.tree, "p", bound) : null;
  if (title && heroTitle) operations.push({ kind: "setText", routeId: "home", targetId: title.id, value: heroTitle });
  if (body && heroBody) operations.push({ kind: "setText", routeId: "home", targetId: body.id, value: heroBody });
  if (!operations.length) return input.recipe;
  if (!patchFitsRecipeOverride(input.recipe.bundle, operations)) throw new Error("Recipe personalization exceeded the declared override surface");
  const applied = applyStorefrontPatch(input.recipe.bundle, operations);
  const report = validateCompiledBundle(applied.bundle);
  if (!report.ok) throw new Error("Personalized recipe failed validation");
  return { bundle: applied.bundle, report };
}
