import type { StorefrontBundleV1, VisualLayerSpec } from "../storefront-bundle/types";
import { isStoreTemplateId } from "../storefront-bundle/registry";
import {
  compileBundle,
  hashCompiledBundle,
  type CompiledBundleResult,
  type StorefrontBundleSourceV1,
} from "../storefront-compiler/compile";
import { validateCompiledBundle } from "../storefront-compiler/validate";
import { recipeCompilerSource, type DefinedRecipe } from "../storefront-recipes/factory";
import { isVisualLayerSpec } from "../storebuilder/fx/shader";

export interface StorefrontAuthoringV1 {
  version: 1;
  source: StorefrontBundleSourceV1;
  overrides: {
    featuredProductIds?: string[];
    visualLayer?: VisualLayerSpec;
  };
}

export interface StorefrontVersionArtifactV1 {
  sourceKind: "recipe" | "custom";
  bundle: StorefrontBundleV1;
  authoring?: StorefrontAuthoringV1;
}

interface CustomSourceProvenance {
  generationId: string;
  promptHash: string;
  derivedFromVersionId: string;
}

const PRODUCT_ID_CAP = 12;
const OVERRIDE_KEYS = new Set(["featuredProductIds", "visualLayer"]);

function validProductIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= PRODUCT_ID_CAP
    && value.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 128)
    && new Set(value.map((id) => id.trim())).size === value.length;
}

function assertValidOverrides(value: unknown): asserts value is StorefrontAuthoringV1["overrides"] {
  if (!isRecord(value) || Object.keys(value).some((key) => !OVERRIDE_KEYS.has(key))
    || (Object.hasOwn(value, "featuredProductIds") && !validProductIds(value.featuredProductIds))
    || (Object.hasOwn(value, "visualLayer") && !isVisualLayerSpec(value.visualLayer))) {
    throw new Error("Invalid storefront authoring overrides");
  }
}

export function compileAuthoring(authoring: StorefrontAuthoringV1): CompiledBundleResult {
  assertValidOverrides(authoring.overrides);
  const compiled = compileBundle(authoring.source);
  const bundle = {
    ...compiled.bundle,
    ...(authoring.overrides.featuredProductIds !== undefined
      ? { featuredProductIds: [...authoring.overrides.featuredProductIds] }
      : {}),
    ...(authoring.overrides.visualLayer !== undefined
      ? { visualLayer: structuredClone(authoring.overrides.visualLayer) }
      : {}),
  };
  return {
    bundle,
    hash: hashCompiledBundle(bundle),
    report: validateCompiledBundle(bundle),
  };
}

export function authoringFromRecipe(
  recipe: DefinedRecipe,
  provenance: CustomSourceProvenance,
): StorefrontVersionArtifactV1 & { authoring: StorefrontAuthoringV1 } {
  const source = structuredClone(recipeCompilerSource(recipe));
  source.source = {
    kind: "custom",
    ...provenance,
    derivedFromTemplateId: recipe.config.templateId,
    derivedFromTemplateVersion: recipe.config.templateVersion,
  };
  const authoring: StorefrontAuthoringV1 = {
    version: 1,
    source,
    overrides: {
      ...(recipe.bundle.featuredProductIds !== undefined
        ? { featuredProductIds: [...recipe.bundle.featuredProductIds] }
        : {}),
      ...(recipe.bundle.visualLayer !== undefined
        ? { visualLayer: structuredClone(recipe.bundle.visualLayer) }
        : {}),
    },
  };
  return { sourceKind: "custom", bundle: compileAuthoring(authoring).bundle, authoring };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasConsistentRecipeAncestry(provenance: Record<string, unknown>): boolean {
  const hasTemplateId = provenance.derivedFromTemplateId !== undefined;
  const hasTemplateVersion = provenance.derivedFromTemplateVersion !== undefined;
  if (hasTemplateId !== hasTemplateVersion) return false;
  return !hasTemplateId || (
    isStoreTemplateId(provenance.derivedFromTemplateId) &&
    Number.isInteger(provenance.derivedFromTemplateVersion) &&
    Number(provenance.derivedFromTemplateVersion) > 0
  );
}

function parseAuthoring(
  value: unknown,
  sourceKind: StorefrontVersionArtifactV1["sourceKind"],
  bundle: StorefrontBundleV1,
): StorefrontAuthoringV1 | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.source) || !isRecord(value.overrides)) {
    return undefined;
  }
  const provenance = value.source.source;
  if (
    sourceKind !== "custom" ||
    bundle.source.kind !== "custom" ||
    !isRecord(provenance) ||
    provenance.kind !== "custom" ||
    !isNonEmptyString(provenance.generationId) ||
    !isNonEmptyString(provenance.promptHash) ||
    !isNonEmptyString(provenance.derivedFromVersionId) ||
    !hasConsistentRecipeAncestry(provenance)
  ) {
    return undefined;
  }
  const authoring = value as unknown as StorefrontAuthoringV1;
  try {
    const compiled = compileAuthoring(authoring);
    return compiled.report.ok && compiled.hash === hashCompiledBundle(bundle) ? authoring : undefined;
  } catch {
    return undefined;
  }
}

export function parseStorefrontVersionArtifact(value: unknown): StorefrontVersionArtifactV1 {
  if (!isRecord(value) || (value.sourceKind !== "recipe" && value.sourceKind !== "custom")) {
    throw new Error("Invalid storefront version artifact");
  }
  const report = validateCompiledBundle(value.bundle);
  if (!report.ok) throw new Error("Invalid storefront version bundle");
  const bundle = value.bundle as StorefrontBundleV1;
  if (value.sourceKind !== bundle.source.kind) throw new Error("Storefront artifact source kind mismatch");
  const authoring = parseAuthoring(value.authoring, value.sourceKind, bundle);
  return {
    sourceKind: value.sourceKind,
    bundle,
    ...(authoring ? { authoring } : {}),
  };
}

export function requireStorefrontAuthoring(artifact: StorefrontVersionArtifactV1): StorefrontAuthoringV1 {
  if (!artifact.authoring) throw new Error("This storefront version has no valid authoring source");
  return artifact.authoring;
}
