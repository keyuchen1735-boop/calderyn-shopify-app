import { isUuid } from "../ids";
import type {
  StorefrontRouteId,
  StoreTemplateId,
  VisualLayerSpec,
} from "../storefront-bundle/types";
import { shaderSourceWithinCap } from "../storebuilder/fx/shader";

export const STORE_COMMAND_LIMITS = {
  promptCodePoints: 4_000,
  contextSlotCodePoints: 120,
  attachments: 5,
  designReferences: 4,
  designReferenceAssetRefCodePoints: 512,
} as const;
const ROUTE_IDS: ReadonlySet<StorefrontRouteId> = new Set([
  "home",
  "collection",
  "product",
  "search",
  "cart",
  "checkout",
]);

export interface PreviewContext {
  routeId: StorefrontRouteId;
  slot?: string;
}

export type StoreAttachment =
  | { kind: "design_reference"; assetRef: string }
  | { kind: "fragment_shader"; source: string };

export type StoreIntent =
  | { kind: "select_design"; prompt: string; excludedTemplateIds: StoreTemplateId[] }
  | { kind: "update_text"; slot: string; value: string }
  | { kind: "update_merchandising"; productIds: string[] }
  | { kind: "update_visual_layer"; visualLayer: VisualLayerSpec }
  | { kind: "structural_edit"; scope: StoreRedesignScope }
  | { kind: "full_redesign" }
  | { kind: "start_over"; prompt: string }
  | { kind: "unsupported"; message: string };

export interface StoreRedesignScope {
  routeId: StorefrontRouteId;
}

export type StoreCommand =
  | {
      kind: "prompt";
      prompt: string;
      expectedDraftVersionId: string | null;
      context?: PreviewContext;
      attachments?: StoreAttachment[];
    }
  | { kind: "undo"; targetVersionId: string; expectedDraftVersionId: string }
  | { kind: "publish"; expectedDraftVersionId: string };

export type StoreCommandReceipt =
  | {
      status: "installed";
      versionId: string;
      undo: { targetVersionId: string; expectedDraftVersionId: string } | null;
    }
  | { status: "published"; versionId: string }
  | { status: "unchanged"; message: string };

export type StoreCommandEvent =
  | { stage: "understanding" | "preparing_products" | "planning_redesign" | "building_pages" | "checking_preview" }
  | { stage: "ready"; receipt: StoreCommandReceipt }
  | { stage: "error"; code: string; status: number; message: string };

export type ParseStoreCommandResult =
  | { ok: true; value: StoreCommand }
  | { ok: false; code: "invalid_store_command" };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// Subset semantics on purpose: callers pass optional keys (a prompt command
// may omit context/attachments), so this rejects unknown keys only; required
// and optional keys are validated per-field by each caller.
function hasNoUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedString(value: unknown, cap: number): value is string {
  return nonEmptyString(value) && Array.from(value).length <= cap;
}

export function isPreviewContext(value: unknown): value is PreviewContext {
  const input = record(value);
  return input !== null
    && hasNoUnknownKeys(input, ["routeId", "slot"])
    && typeof input.routeId === "string"
    && ROUTE_IDS.has(input.routeId as StorefrontRouteId)
    && (input.slot === undefined || boundedString(input.slot, STORE_COMMAND_LIMITS.contextSlotCodePoints));
}

function isStoreAttachment(value: unknown): value is StoreAttachment {
  const input = record(value);
  if (input?.kind === "design_reference") {
    return hasNoUnknownKeys(input, ["kind", "assetRef"])
      && boundedString(input.assetRef, STORE_COMMAND_LIMITS.designReferenceAssetRefCodePoints);
  }
  if (input?.kind === "fragment_shader") {
    return hasNoUnknownKeys(input, ["kind", "source"])
      && nonEmptyString(input.source)
      && shaderSourceWithinCap(input.source);
  }
  return false;
}

export function isStoreAttachmentList(value: unknown): value is StoreAttachment[] {
  if (!Array.isArray(value) || value.length > STORE_COMMAND_LIMITS.attachments
    || !value.every(isStoreAttachment)) return false;
  return value.filter((attachment) => attachment.kind === "design_reference").length
      <= STORE_COMMAND_LIMITS.designReferences
    && value.filter((attachment) => attachment.kind === "fragment_shader").length <= 1;
}

function invalidStoreCommand(): ParseStoreCommandResult {
  return { ok: false, code: "invalid_store_command" };
}

export function parseStoreCommand(value: unknown): ParseStoreCommandResult {
  const input = record(value);
  if (!input || typeof input.kind !== "string") return invalidStoreCommand();

  if (input.kind === "prompt") {
    if (!hasNoUnknownKeys(input, ["kind", "prompt", "expectedDraftVersionId", "context", "attachments"])
      || !nonEmptyString(input.prompt)
      || Array.from(input.prompt).length > STORE_COMMAND_LIMITS.promptCodePoints
      || (input.expectedDraftVersionId !== null
        && (typeof input.expectedDraftVersionId !== "string" || !isUuid(input.expectedDraftVersionId)))
      || (input.context !== undefined && !isPreviewContext(input.context))
      || (input.attachments !== undefined && !isStoreAttachmentList(input.attachments))) {
      return invalidStoreCommand();
    }

    return {
      ok: true,
      value: {
        kind: "prompt",
        prompt: input.prompt,
        expectedDraftVersionId: input.expectedDraftVersionId,
        ...(input.context ? { context: input.context } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
      },
    };
  }

  if (input.kind === "undo") {
    if (!hasNoUnknownKeys(input, ["kind", "targetVersionId", "expectedDraftVersionId"])
      || typeof input.targetVersionId !== "string"
      || !isUuid(input.targetVersionId)
      || typeof input.expectedDraftVersionId !== "string"
      || !isUuid(input.expectedDraftVersionId)) {
      return invalidStoreCommand();
    }
    return {
      ok: true,
      value: {
        kind: "undo",
        targetVersionId: input.targetVersionId,
        expectedDraftVersionId: input.expectedDraftVersionId,
      },
    };
  }

  if (input.kind === "publish") {
    if (!hasNoUnknownKeys(input, ["kind", "expectedDraftVersionId"])
      || typeof input.expectedDraftVersionId !== "string"
      || !isUuid(input.expectedDraftVersionId)) {
      return invalidStoreCommand();
    }
    return {
      ok: true,
      value: { kind: "publish", expectedDraftVersionId: input.expectedDraftVersionId },
    };
  }

  return invalidStoreCommand();
}
