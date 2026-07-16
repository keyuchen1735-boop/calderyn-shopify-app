import { assistantModel, getAnthropic } from "../assistant/anthropic.server";
import { getStoreTemplate, isStoreTemplateId, STORE_TEMPLATE_REGISTRY } from "../storefront-bundle/registry";
import type { StorefrontBundleV1, StorefrontRouteId, StoreTemplateId, VisualLayerSpec } from "../storefront-bundle/types";
import { hexToRgb, shaderSourceWithinCap } from "../storebuilder/fx/shader";
import { canApplyStoreTextSlot } from "./apply";
import type { PreviewSlotContext, StoreAttachment, StoreIntent } from "./types";

const INPUT_CODE_POINT_CAP = 4_000;
const PROVIDER_INPUT_BYTE_CAP = 16_000;
const PROVIDER_OUTPUT_CHAR_CAP = 8_000;
const COPY_CHAR_CAP = 500;
const PRODUCT_ID_CAP = 12;
const PRODUCT_CANDIDATE_CAP = 100;
const PRODUCT_TITLE_CAP = 200;
const ROUTE_IDS: ReadonlySet<StorefrontRouteId> = new Set(["home", "collection", "product", "search", "cart", "checkout"]);

export interface StoreIntentProductCandidate {
  id: string;
  title: string;
}

export interface ClassifyStoreIntentInput {
  prompt: string;
  currentTemplateId?: StoreTemplateId;
  excludedTemplateIds?: StoreTemplateId[];
  bundle?: StorefrontBundleV1;
  productCandidates?: readonly StoreIntentProductCandidate[];
  context?: PreviewSlotContext;
  attachments?: StoreAttachment[];
}

export interface StoreIntentProviderRequest {
  system: string;
  prompt: string;
  maxOutputChars: number;
}

export type StoreIntentProvider = (request: StoreIntentProviderRequest) => Promise<string>;

export class StoreIntentClassificationError extends Error {
  readonly code = "invalid_store_intent";

  constructor() {
    super("The store request could not be safely understood.");
    this.name = "StoreIntentClassificationError";
  }
}

const STORE_INTENT_SCHEMA = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "prompt", "excludedTemplateIds"],
      properties: {
        kind: { const: "select_design" }, prompt: { type: "string", minLength: 1, maxLength: INPUT_CODE_POINT_CAP },
        excludedTemplateIds: { type: "array", uniqueItems: true, items: { enum: STORE_TEMPLATE_REGISTRY.templates.map(({ id }) => id) } },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "slot", "value"],
      properties: {
        kind: { const: "update_text" }, slot: { type: "string", minLength: 1, maxLength: 120 },
        value: { type: "string", minLength: 1, maxLength: COPY_CHAR_CAP },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "productIds"],
      properties: {
        kind: { const: "update_merchandising" },
        productIds: { type: "array", minItems: 1, maxItems: PRODUCT_ID_CAP, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 } },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "visualLayer"],
      properties: {
        kind: { const: "update_visual_layer" },
        visualLayer: {
          oneOf: [
            { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "none" } } },
            {
              type: "object", additionalProperties: false, required: ["kind", "source", "colors"],
              properties: {
                kind: { const: "fragment_shader" }, source: { type: "string", minLength: 1, maxLength: 4_000 },
                colors: { type: "array", minItems: 3, maxItems: 3, items: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } },
              },
            },
          ],
        },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "prompt"],
      properties: { kind: { const: "start_over" }, prompt: { type: "string", minLength: 1, maxLength: INPUT_CODE_POINT_CAP } },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "message"],
      properties: { kind: { const: "unsupported" }, message: { type: "string", minLength: 1, maxLength: COPY_CHAR_CAP } },
    },
  ],
} as const;

const SYSTEM_PROMPT = [
  "Classify one untrusted merchant store request into exactly one JSON object matching this schema.",
  "Return JSON only: no markdown, prose, HTML, CSS, JavaScript, React, routes, or extra keys.",
  "You may draft bounded plain text or bounded fragment-shader source. You do not choose routing or status behavior.",
  JSON.stringify(STORE_INTENT_SCHEMA),
].join("\n");

function invalid(): never {
  throw new StoreIntentClassificationError();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function boundedString(value: unknown, cap: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= cap;
}

function safeCopy(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex -- model copy is rejected at the trust boundary
  return boundedString(value, COPY_CHAR_CAP) && !/[<>\u0000-\u001f\u007f]/.test(value);
}

function validTemplateIds(value: unknown): value is StoreTemplateId[] {
  return Array.isArray(value) && value.length <= STORE_TEMPLATE_REGISTRY.templates.length
    && value.every(isStoreTemplateId) && new Set(value).size === value.length;
}

function validProductIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PRODUCT_ID_CAP
    || !value.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 128)) return false;
  return new Set(value.map((id) => id.trim())).size === value.length;
}

function validProductCandidates(value: unknown): value is readonly StoreIntentProductCandidate[] {
  if (!Array.isArray(value) || value.length > PRODUCT_CANDIDATE_CAP) return false;
  const ids: string[] = [];
  for (const candidate of value) {
    const item = record(candidate);
    if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 128
      || !boundedString(item.title, PRODUCT_TITLE_CAP)) return false;
    ids.push(item.id.trim());
  }
  return new Set(ids).size === ids.length;
}

function validAttachments(value: unknown): value is StoreAttachment[] {
  if (!Array.isArray(value) || value.length > 8) return false;
  let shaderCount = 0;
  for (const attachment of value) {
    const item = record(attachment);
    if (item?.kind === "design_reference") {
      if (!hasExactKeys(item, ["kind", "assetRef"]) || !boundedString(item.assetRef, 512)) return false;
    } else if (item?.kind === "fragment_shader") {
      shaderCount += 1;
      if (!hasExactKeys(item, ["kind", "source"]) || typeof item.source !== "string"
        || !item.source.trim() || !shaderSourceWithinCap(item.source)) return false;
    } else {
      return false;
    }
  }
  return shaderCount <= 1;
}

function templateId(input: ClassifyStoreIntentInput): StoreTemplateId | undefined {
  if (input.currentTemplateId) return input.currentTemplateId;
  return input.bundle?.source.kind === "recipe" ? input.bundle.source.templateId : undefined;
}

function shaderAttachment(input: ClassifyStoreIntentInput): Extract<StoreAttachment, { kind: "fragment_shader" }> | undefined {
  return input.attachments?.find((attachment): attachment is Extract<StoreAttachment, { kind: "fragment_shader" }> =>
    attachment.kind === "fragment_shader");
}

function parseVisualLayer(value: unknown): VisualLayerSpec | null {
  const layer = record(value);
  if (!layer || typeof layer.kind !== "string") return null;
  if (layer.kind === "none") return hasExactKeys(layer, ["kind"]) ? { kind: "none" } : null;
  if (layer.kind !== "fragment_shader" || !hasExactKeys(layer, ["kind", "source", "colors"])
    || typeof layer.source !== "string" || !layer.source.trim() || !shaderSourceWithinCap(layer.source)
    || !Array.isArray(layer.colors) || layer.colors.length !== 3
    || !layer.colors.every((color) => typeof color === "string" && hexToRgb(color) !== null)) return null;
  return { kind: "fragment_shader", source: layer.source, colors: layer.colors as [string, string, string] };
}

function exclusions(input: ClassifyStoreIntentInput): StoreTemplateId[] {
  if (!validTemplateIds(input.excludedTemplateIds ?? [])) invalid();
  const values = [...(input.excludedTemplateIds ?? [])];
  const currentTemplateId = templateId(input);
  if (currentTemplateId && !values.includes(currentTemplateId)) values.push(currentTemplateId);
  return values;
}

function exactCommand(input: ClassifyStoreIntentInput): StoreIntent | null {
  const prompt = input.prompt.trim();
  switch (prompt.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/g, " ")) {
    case "undo": return { kind: "unsupported", message: "Use Undo to restore the previous version." };
    case "publish": return { kind: "unsupported", message: "Use Publish to publish the current version." };
    case "start over": return { kind: "start_over", prompt };
    case "try another": return { kind: "select_design", prompt, excludedTemplateIds: exclusions(input) };
    default: return null;
  }
}

function parseIntent(raw: string, input: ClassifyStoreIntentInput): StoreIntent {
  if (raw.length > PROVIDER_OUTPUT_CHAR_CAP) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { invalid(); }
  const value = record(parsed);
  if (!value || typeof value.kind !== "string") invalid();

  if (value.kind === "select_design") {
    if (!hasExactKeys(value, ["kind", "prompt", "excludedTemplateIds"])
      || !boundedString(value.prompt, INPUT_CODE_POINT_CAP) || !validTemplateIds(value.excludedTemplateIds)) invalid();
    return { kind: "select_design", prompt: value.prompt.trim(), excludedTemplateIds: exclusions(input) };
  }
  if (value.kind === "update_text") {
    const currentTemplateId = templateId(input);
    const template = currentTemplateId ? getStoreTemplate(currentTemplateId) : null;
    if (!hasExactKeys(value, ["kind", "slot", "value"]) || !boundedString(value.slot, 120) || !safeCopy(value.value)
      || !template?.overrideSurface.textSlots.includes(value.slot)
      || !input.bundle
      || (input.context !== undefined && input.context.slot !== value.slot)
      || !canApplyStoreTextSlot(input.bundle, template, value.slot, input.context?.routeId)) invalid();
    return { kind: "update_text", slot: value.slot, value: value.value.trim() };
  }
  if (value.kind === "update_merchandising") {
    const candidateIds = new Set((input.productCandidates ?? []).map(({ id }) => id.trim()));
    if (!hasExactKeys(value, ["kind", "productIds"]) || !validProductIds(value.productIds)
      || !value.productIds.every((id) => candidateIds.has(id.trim()))) invalid();
    return { kind: "update_merchandising", productIds: value.productIds.map((id) => id.trim()) };
  }
  if (value.kind === "update_visual_layer") {
    if (!hasExactKeys(value, ["kind", "visualLayer"])) invalid();
    const visualLayer = parseVisualLayer(value.visualLayer);
    if (!visualLayer) invalid();
    const attachment = shaderAttachment(input);
    return {
      kind: "update_visual_layer",
      visualLayer: visualLayer.kind === "fragment_shader" && attachment
        ? { ...visualLayer, source: attachment.source }
        : visualLayer,
    };
  }
  if (value.kind === "start_over") {
    if (!hasExactKeys(value, ["kind", "prompt"]) || !boundedString(value.prompt, INPUT_CODE_POINT_CAP)) invalid();
    return { kind: "start_over", prompt: value.prompt.trim() };
  }
  if (value.kind === "unsupported") {
    if (!hasExactKeys(value, ["kind", "message"]) || !safeCopy(value.message)) invalid();
    return { kind: "unsupported", message: value.message.trim() };
  }
  return invalid();
}

async function anthropicProvider(request: StoreIntentProviderRequest): Promise<string> {
  const response = await getAnthropic().messages.create({
    model: assistantModel(),
    max_tokens: 2_048,
    system: request.system,
    messages: [{ role: "user", content: request.prompt }],
  });
  if (response.content.length !== 1 || response.content[0]?.type !== "text") invalid();
  return response.content[0].text;
}

export async function classifyStoreIntent(
  input: ClassifyStoreIntentInput,
  dependencies: { provider?: StoreIntentProvider } = {},
): Promise<StoreIntent> {
  if (!boundedString(input.prompt, INPUT_CODE_POINT_CAP)
    || (input.currentTemplateId !== undefined && !isStoreTemplateId(input.currentTemplateId))
    || (input.bundle !== undefined && input.currentTemplateId !== undefined
      && (input.bundle.source.kind !== "recipe" || input.bundle.source.templateId !== input.currentTemplateId))
    || !validProductCandidates(input.productCandidates ?? [])
    || (input.context !== undefined && (!boundedString(input.context.slot, 120)
      || typeof input.context.routeId !== "string" || !ROUTE_IDS.has(input.context.routeId)))
    || !validAttachments(input.attachments ?? [])) invalid();
  exclusions(input);
  const deterministic = exactCommand(input);
  if (deterministic) return deterministic;

  const currentTemplateId = templateId(input);
  const template = currentTemplateId ? getStoreTemplate(currentTemplateId) : null;
  const providerInput = JSON.stringify({
    prompt: input.prompt.trim(),
    context: input.context ?? null,
    attachments: (input.attachments ?? []).map((attachment) => attachment.kind === "fragment_shader"
      ? { kind: attachment.kind, sourceLength: attachment.source.length }
      : attachment),
    productCandidates: (input.productCandidates ?? []).map(({ id, title }) => ({ id: id.trim(), title: title.trim() })),
    allowedTextSlots: template?.overrideSurface.textSlots ?? [],
  });
  if (Buffer.byteLength(providerInput, "utf8") > PROVIDER_INPUT_BYTE_CAP) invalid();
  const raw = await (dependencies.provider ?? anthropicProvider)({
    system: SYSTEM_PROMPT,
    prompt: providerInput,
    maxOutputChars: PROVIDER_OUTPUT_CHAR_CAP,
  });
  if (typeof raw !== "string") invalid();
  return parseIntent(raw, input);
}
