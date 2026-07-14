import type {
  CuratedFontId,
  StorefrontBundleV1,
  StorefrontRouteId,
  StoreTemplateId,
} from "../storefront-bundle/types";

export interface PreviewEditContext {
  routeId: StorefrontRouteId;
  /** Compiler-issued element ID from the preview DOM, never a CSS selector. */
  regionId: string;
}

export type StorefrontPatchOperation =
  | { kind: "setToken"; tokenId: string; value: string; expected?: string }
  | { kind: "setFont"; target: "display" | "body"; fontId: CuratedFontId; expected?: CuratedFontId }
  | { kind: "setText" | "replaceTextChildren"; routeId: StorefrontRouteId; targetId: string; value: string; expected?: string }
  | { kind: "setVisibility"; routeId: StorefrontRouteId; targetId: string; hidden: boolean }
  | { kind: "moveRegion"; routeId: StorefrontRouteId; targetId: string; direction: "up" | "down" }
  | { kind: "reorderChildren"; routeId: StorefrontRouteId; parentId: string; childIds: string[]; expected?: string[] };

export type ParsedEditIntent =
  | { kind: "deterministic"; operations: StorefrontPatchOperation[] }
  | { kind: "structural"; context?: PreviewEditContext }
  | { kind: "startOver" };

export interface StorefrontPatchProviderAudit {
  kind: "deterministic" | "ai_patch";
  provider?: string;
  model: string | null;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CompiledStorefrontPatch {
  operations: StorefrontPatchOperation[];
  provider: StorefrontPatchProviderAudit;
}

export interface LoadedStorefrontDraft {
  versionId: string;
  artifactHash: string;
  bundle: StorefrontBundleV1;
}

export interface StorefrontChangedScope {
  designTokens: string[];
  routes: StorefrontRouteId[];
}

export interface StorefrontEditReceipt {
  status: "installed";
  versionId: string;
  baseVersionId: string;
  bundle: StorefrontBundleV1;
  changedScope: StorefrontChangedScope;
  detachedFromRecipe: boolean;
  undo: { targetVersionId: string; expectedDraftVersionId: string };
}

export interface RecipeDerivation {
  templateId: StoreTemplateId;
  templateVersion: number;
}
