import type {
  CuratedFontId,
  StorefrontBundleV1,
  StorefrontRouteId,
  StoreTemplateId,
} from "../storefront-bundle/types";
import type { BrowserProofReport } from "../storefront-ai/contracts";

export interface StorefrontRegionSource {
  /** Compiler-source fragment. It is parsed by the closed HTML compiler; scripts and arbitrary URLs are forbidden. */
  html: string;
  /** Route-scoped compiler-source CSS. */
  css: string;
}

export interface PreviewEditContext {
  routeId: StorefrontRouteId;
  /** Compiler-issued element ID from the preview DOM, never a CSS selector. */
  regionId: string;
}

export interface StructuralPatchScope {
  routeId: StorefrontRouteId;
  regionId?: string;
}

export type StorefrontPatchOperation =
  | { kind: "setToken"; tokenId: string; value: string; expected?: string }
  | { kind: "setFont"; target: "display" | "body"; fontId: CuratedFontId; expected?: CuratedFontId }
  | { kind: "setText" | "replaceTextChildren"; routeId: StorefrontRouteId; targetId: string; value: string; expected?: string }
  | { kind: "setVisibility"; routeId: StorefrontRouteId; targetId: string; hidden: boolean; expected?: string }
  | { kind: "moveRegion"; routeId: StorefrontRouteId; targetId: string; direction: "up" | "down" }
  | { kind: "reorderChildren"; routeId: StorefrontRouteId; parentId: string; childIds: string[]; expected?: string[] }
  | {
      kind: "replaceRegion";
      routeId: Exclude<StorefrontRouteId, "checkout">;
      targetId: string;
      /** SHA-256 of the exact compiled subtree being replaced. */
      expected: string;
      source: StorefrontRegionSource;
    }
  | {
      kind: "replaceRouteCss";
      routeId: Exclude<StorefrontRouteId, "checkout">;
      /** SHA-256 of the current compiled route CSS. */
      expected: string;
      css: string;
    };

export type ParsedEditIntent =
  | { kind: "deterministic"; operations: StorefrontPatchOperation[] }
  | { kind: "structural"; context?: PreviewEditContext }
  | { kind: "startOver"; mode: "auto" | "custom" };

export type StorefrontStartOverReceipt = { status: "start_over"; mode: "auto" | "custom" };

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
  resolution?: Record<string, unknown>;
}

export interface StorefrontChangedScope {
  designTokens: string[];
  routes: StorefrontRouteId[];
  regions?: string[];
  css?: StorefrontRouteId[];
  interactions?: StorefrontRouteId[];
  assets?: string[];
  /** Compiler IDs safe to hand back to preview selection; never selectors. */
  compilerIds?: string[];
}

export interface StorefrontEditBrowserProof {
  ok: true;
  diagnostics: [];
  screenshots: string[];
  browserMs: number;
}

export interface StorefrontEditReceipt {
  status: "installed";
  versionId: string;
  baseVersionId: string;
  bundle: StorefrontBundleV1;
  changedScope: StorefrontChangedScope;
  browserProof: BrowserProofReport;
  detachedFromRecipe: boolean;
  undo: { targetVersionId: string; expectedDraftVersionId: string };
}

export type StorefrontEditStage = "compiling" | "validating" | "proofing" | "installing";

export type StorefrontEditEvent =
  | { stage: StorefrontEditStage }
  | { stage: "installed"; receipt: StorefrontEditReceipt }
  | { stage: "start_over"; receipt: StorefrontStartOverReceipt }
  | { stage: "error"; code: string; status: number; message: string };

export interface RecipeDerivation {
  templateId: StoreTemplateId;
  templateVersion: number;
}
