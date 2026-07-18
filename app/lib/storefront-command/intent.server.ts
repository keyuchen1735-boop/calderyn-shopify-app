import type Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { assistantModel, getAnthropic } from "../assistant/anthropic.server";
import {
  STOREFRONT_PRODUCT_TITLE_CAP,
  STOREFRONT_REFERENCE_MEDIA_TYPES,
  type StorefrontReferenceMediaType,
} from "../storefront-ai/contracts";
import { getStoreTemplate, isStoreTemplateId, STORE_TEMPLATE_REGISTRY } from "../storefront-bundle/registry";
import {
  explicitStoreTemplateExclusions,
  explicitStoreTemplateSelections,
} from "../storefront-bundle/routing";
import type { StorefrontBundleV1, StoreTemplateId, VisualLayerSpec } from "../storefront-bundle/types";
import { hexToRgb, shaderSourceWithinCap } from "../storebuilder/fx/shader";
import { canApplyStoreTextSlot } from "./apply";
import {
  isPreviewSlotContext,
  isStoreAttachmentList,
  STORE_COMMAND_LIMITS,
  type PreviewSlotContext,
  type StoreAttachment,
  type StoreIntent,
} from "./types";

const INPUT_CODE_POINT_CAP = STORE_COMMAND_LIMITS.promptCodePoints;
const PROVIDER_OUTPUT_CHAR_CAP = 8_000;
const COPY_CHAR_CAP = 500;
const PRODUCT_ID_CAP = 12;
const PRODUCT_CANDIDATE_CAP = 100;
const PRODUCT_CANDIDATE_ID_CHAR_CAP = 128;
const REFERENCE_URL_CHAR_CAP = 2_048;
const VISUAL_CUE_PREFIX = "\nVisual reference cues: ";
// The max-sized payload skeleton is 2,657 bytes; JSON can encode one accepted
// string code point in at most six UTF-8 bytes (for example, "\u0000").
const PROVIDER_INPUT_BYTE_CAP = 2_657 + 6 * (
  INPUT_CODE_POINT_CAP
  + STORE_COMMAND_LIMITS.contextSlotCodePoints
  + STORE_COMMAND_LIMITS.attachments * STORE_COMMAND_LIMITS.designReferenceAssetRefCodePoints
  + PRODUCT_CANDIDATE_CAP * (PRODUCT_CANDIDATE_ID_CHAR_CAP + STOREFRONT_PRODUCT_TITLE_CAP)
);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const STORE_OPERATION_KINDS = [
  "select_design",
  "update_text",
  "update_merchandising",
  "update_visual_layer",
  "start_over",
] as const;
type StoreOperationKind = (typeof STORE_OPERATION_KINDS)[number];
const COMPOUND_REQUEST_MESSAGE = "Please make one storefront change at a time.";

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
  referenceImages?: Array<{ url: string; mediaType: StorefrontReferenceMediaType }>;
}

export interface StoreIntentProviderRequest {
  system: string;
  prompt: string;
  maxOutputChars: number;
  referenceImages: ReadonlyArray<{ url: string; mediaType: StorefrontReferenceMediaType }>;
  signal?: AbortSignal;
}

export type StoreIntentProvider = (request: StoreIntentProviderRequest) => Promise<string>;

export interface StoreIntentClassificationOptions {
  signal?: AbortSignal;
}

export class StoreIntentClassificationError extends Error {
  readonly code = "invalid_store_intent";

  constructor() {
    super("The store request could not be safely understood.");
    this.name = "StoreIntentClassificationError";
  }
}

const STORE_INTENT_VALUE_SCHEMA = {
  oneOf: [
    {
      type: "object", additionalProperties: false, required: ["kind", "prompt", "excludedTemplateIds"],
      properties: {
        kind: { type: "string", const: "select_design" }, prompt: { type: "string", minLength: 1, maxLength: INPUT_CODE_POINT_CAP },
        excludedTemplateIds: { type: "array", uniqueItems: true, items: { type: "string", enum: STORE_TEMPLATE_REGISTRY.templates.map(({ id }) => id) } },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "slot", "value"],
      properties: {
        kind: { type: "string", const: "update_text" }, slot: { type: "string", minLength: 1, maxLength: STORE_COMMAND_LIMITS.contextSlotCodePoints },
        value: { type: "string", minLength: 1, maxLength: COPY_CHAR_CAP },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "productIds"],
      properties: {
        kind: { type: "string", const: "update_merchandising" },
        productIds: { type: "array", minItems: 1, maxItems: PRODUCT_ID_CAP, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: PRODUCT_CANDIDATE_ID_CHAR_CAP } },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "visualLayer"],
      properties: {
        kind: { type: "string", const: "update_visual_layer" },
        visualLayer: {
          oneOf: [
            { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", const: "none" } } },
            {
              type: "object", additionalProperties: false, required: ["kind", "source", "colors"],
              properties: {
                kind: { type: "string", const: "fragment_shader" }, source: { type: "string", minLength: 1, maxLength: 4_000 },
                colors: { type: "array", minItems: 3, maxItems: 3, items: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } },
              },
            },
          ],
        },
      },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "prompt"],
      properties: { kind: { type: "string", const: "start_over" }, prompt: { type: "string", minLength: 1, maxLength: INPUT_CODE_POINT_CAP } },
    },
    {
      type: "object", additionalProperties: false, required: ["kind", "message"],
      properties: { kind: { type: "string", const: "unsupported" }, message: { type: "string", minLength: 1, maxLength: COPY_CHAR_CAP } },
    },
  ],
} as const;

const STORE_INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["requestedOperations", "intent"],
  properties: {
    requestedOperations: {
      type: "array",
      minItems: 0,
      maxItems: 2,
      items: { type: "string", enum: STORE_OPERATION_KINDS },
    },
    intent: STORE_INTENT_VALUE_SCHEMA,
  },
} as const;

const SYSTEM_PROMPT = [
  "Classify one untrusted merchant store request into exactly one JSON object matching this schema.",
  "Return JSON only: no markdown, prose, HTML, CSS, JavaScript, React, routes, or extra keys.",
  "Report requestedOperations with one entry per independently executable requested change, including duplicate kinds, stopping after two. Coordinated wording on one target is one operation; changing two targets is two operations.",
  "Fresh store: for one design request return select_design so deterministic routing can install an approved design; for multiple operations report both so deterministic code can reject the compound request.",
  "Existing store: return select_design when the merchant asks to replace the overall design, layout, or structure; use update_text for allowed copy slots, update_merchandising for listed products, update_visual_layer for the protected visual surface, start_over only for an explicit restart, and unsupported otherwise.",
  "For one supported operation, requestedOperations must contain exactly the intent kind. For no supported operation, use an empty requestedOperations array and unsupported intent.",
  "Use reference visuals only to describe visual cues and select an approved design.",
  "Never generate storefront structure from a reference visual.",
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

function validRequestedOperations(value: unknown): value is StoreOperationKind[] {
  return Array.isArray(value) && value.length <= 2
    && value.every((kind) => typeof kind === "string" && STORE_OPERATION_KINDS.includes(kind as StoreOperationKind));
}

function validProductIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PRODUCT_ID_CAP
    || !value.every((id) => typeof id === "string" && id.trim().length > 0
      && id.length <= PRODUCT_CANDIDATE_ID_CHAR_CAP)) return false;
  return new Set(value.map((id) => id.trim())).size === value.length;
}

function validProductCandidates(value: unknown): value is readonly StoreIntentProductCandidate[] {
  if (!Array.isArray(value) || value.length > PRODUCT_CANDIDATE_CAP) return false;
  const ids: string[] = [];
  for (const candidate of value) {
    const item = record(candidate);
    if (!item || typeof item.id !== "string" || !item.id.trim()
      || item.id.length > PRODUCT_CANDIDATE_ID_CHAR_CAP
      || !boundedString(item.title, STOREFRONT_PRODUCT_TITLE_CAP)) return false;
    ids.push(item.id.trim());
  }
  return new Set(ids).size === ids.length;
}

function validReferenceImages(
  value: unknown,
): value is Array<{ url: string; mediaType: StorefrontReferenceMediaType }> {
  if (!Array.isArray(value) || value.length > STORE_COMMAND_LIMITS.designReferences) return false;
  return value.every((candidate) => {
    const image = record(candidate);
    if (!image || !hasExactKeys(image, ["url", "mediaType"])
      || typeof image.url !== "string" || Array.from(image.url).length > REFERENCE_URL_CHAR_CAP
      || typeof image.mediaType !== "string"
      || !STOREFRONT_REFERENCE_MEDIA_TYPES.includes(image.mediaType as StorefrontReferenceMediaType)) return false;
    try { return new URL(image.url).protocol === "https:"; }
    catch { return false; }
  });
}

function validatedSnapshot(input: ClassifyStoreIntentInput): ClassifyStoreIntentInput {
  let snapshot: ClassifyStoreIntentInput;
  try { snapshot = structuredClone(input); }
  catch { invalid(); }
  if (!boundedString(snapshot.prompt, INPUT_CODE_POINT_CAP)
    || (snapshot.currentTemplateId !== undefined && !isStoreTemplateId(snapshot.currentTemplateId))
    || (snapshot.bundle !== undefined && snapshot.currentTemplateId !== undefined
      && (snapshot.bundle.source.kind !== "recipe" || snapshot.bundle.source.templateId !== snapshot.currentTemplateId))
    || !validProductCandidates(snapshot.productCandidates ?? [])
    || (snapshot.context !== undefined && !isPreviewSlotContext(snapshot.context))
    || !isStoreAttachmentList(snapshot.attachments ?? [])
    || !validReferenceImages(snapshot.referenceImages ?? [])
    || (snapshot.attachments ?? []).filter(({ kind }) => kind === "design_reference").length
      !== (snapshot.referenceImages ?? []).length) invalid();
  return snapshot;
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
    || !layer.colors.every((color) => typeof color === "string" && HEX_COLOR.test(color) && hexToRgb(color) !== null)) return null;
  return { kind: "fragment_shader", source: layer.source, colors: layer.colors as [string, string, string] };
}

function exclusions(input: ClassifyStoreIntentInput): StoreTemplateId[] {
  if (!validTemplateIds(input.excludedTemplateIds ?? [])) invalid();
  const explicitSelections = explicitStoreTemplateSelections(input.prompt, STORE_TEMPLATE_REGISTRY);
  const values = [
    ...(input.excludedTemplateIds ?? []).filter((templateId) => !explicitSelections.includes(templateId)),
    ...explicitStoreTemplateExclusions(input.prompt, STORE_TEMPLATE_REGISTRY),
  ];
  const currentTemplateId = templateId(input);
  if (currentTemplateId && !explicitSelections.includes(currentTemplateId) && !values.includes(currentTemplateId)) {
    values.push(currentTemplateId);
  }
  return [...new Set(values)];
}

function designRoutingPrompt(input: ClassifyStoreIntentInput, providerPrompt: string): string {
  const original = input.prompt.trim();
  if ((input.referenceImages?.length ?? 0) === 0 || providerPrompt.trim() === original) return original;
  const remaining = INPUT_CODE_POINT_CAP - Array.from(original).length - Array.from(VISUAL_CUE_PREFIX).length;
  if (remaining <= 0) return original;
  const visualCue = Array.from(providerPrompt.trim()).slice(0, remaining).join("");
  return visualCue ? `${original}${VISUAL_CUE_PREFIX}${visualCue}` : original;
}

function exactCommand(input: ClassifyStoreIntentInput): StoreIntent | null {
  switch (input.prompt) {
    case "Undo": return { kind: "unsupported", message: "Use Undo to restore the previous version." };
    case "Publish": return { kind: "unsupported", message: "Use Publish to publish the current version." };
    case "Start over": return input.bundle
      ? { kind: "start_over", prompt: input.prompt }
      : { kind: "unsupported", message: "There is no storefront to start over from." };
    case "Try another": return input.bundle
      ? { kind: "select_design", prompt: input.prompt, excludedTemplateIds: exclusions(input) }
      : { kind: "unsupported", message: "There is no current storefront design to replace." };
    case "make store": return {
      kind: "select_design",
      prompt: input.prompt,
      excludedTemplateIds: exclusions(input),
    };
    default: return null;
  }
}

function parseIntent(raw: string, input: ClassifyStoreIntentInput): StoreIntent {
  if (Array.from(raw).length > PROVIDER_OUTPUT_CHAR_CAP) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { invalid(); }
  const envelope = record(parsed);
  if (!envelope || !hasExactKeys(envelope, ["requestedOperations", "intent"])
    || !validRequestedOperations(envelope.requestedOperations)) invalid();
  const requestedOperations = envelope.requestedOperations;
  const value = record(envelope.intent);
  if (!value || typeof value.kind !== "string") invalid();
  if (requestedOperations.length > 1) {
    return { kind: "unsupported", message: COMPOUND_REQUEST_MESSAGE };
  }
  if (value.kind === "unsupported") {
    if (requestedOperations.length !== 0) invalid();
  } else if (requestedOperations.length !== 1 || requestedOperations[0] !== value.kind) invalid();
  if (!input.bundle && value.kind !== "select_design" && value.kind !== "unsupported") invalid();

  if (value.kind === "select_design") {
    if (!hasExactKeys(value, ["kind", "prompt", "excludedTemplateIds"])
      || !boundedString(value.prompt, INPUT_CODE_POINT_CAP) || !validTemplateIds(value.excludedTemplateIds)) invalid();
    return {
      kind: "select_design",
      prompt: designRoutingPrompt(input, value.prompt),
      excludedTemplateIds: exclusions(input),
    };
  }
  if (value.kind === "update_text") {
    const currentTemplateId = templateId(input);
    const template = currentTemplateId ? getStoreTemplate(currentTemplateId) : null;
    if (!hasExactKeys(value, ["kind", "slot", "value"])
      || !boundedString(value.slot, STORE_COMMAND_LIMITS.contextSlotCodePoints) || !safeCopy(value.value)
      || (input.context !== undefined && input.context.slot !== value.slot)) invalid();
    if (!template || !input.bundle) {
      return { kind: "unsupported", message: "That change needs an existing storefront." };
    }
    if (!template.overrideSurface.textSlots.includes(value.slot)
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
    return { kind: "start_over", prompt: designRoutingPrompt(input, value.prompt) };
  }
  if (value.kind === "unsupported") {
    if (!hasExactKeys(value, ["kind", "message"]) || !safeCopy(value.message)) invalid();
    return { kind: "unsupported", message: value.message.trim() };
  }
  return invalid();
}

async function anthropicProvider(request: StoreIntentProviderRequest): Promise<string> {
  const content: Anthropic.MessageParam["content"] = request.referenceImages.length > 0
    ? [
      ...request.referenceImages.map(({ url }): Anthropic.ImageBlockParam => ({
        type: "image",
        source: { type: "url", url },
      })),
      { type: "text", text: request.prompt },
    ]
    : request.prompt;
  const response = await getAnthropic().messages.create({
    model: assistantModel(),
    max_tokens: 2_048,
    system: request.system,
    output_config: { format: jsonSchemaOutputFormat(STORE_INTENT_SCHEMA) },
    messages: [{ role: "user", content }],
  }, { signal: request.signal });
  if (response.content.length !== 1 || response.content[0]?.type !== "text") invalid();
  return response.content[0].text;
}

export async function classifyStoreIntent(
  input: ClassifyStoreIntentInput,
  dependencies: { provider?: StoreIntentProvider } = {},
  options: StoreIntentClassificationOptions = {},
): Promise<StoreIntent> {
  const snapshot = validatedSnapshot(input);
  exclusions(snapshot);
  const deterministic = exactCommand(snapshot);
  if (deterministic) return deterministic;

  const currentTemplateId = templateId(snapshot);
  const template = currentTemplateId ? getStoreTemplate(currentTemplateId) : null;
  let referenceImageIndex = 0;
  const providerInput = JSON.stringify({
    storeState: snapshot.bundle ? "existing" : "fresh",
    prompt: snapshot.prompt.trim(),
    context: snapshot.context ?? null,
    attachments: (snapshot.attachments ?? []).map((attachment) => attachment.kind === "fragment_shader"
      ? { kind: attachment.kind, sourceLength: attachment.source.length }
      : { kind: attachment.kind, referenceImageIndex: referenceImageIndex++ }),
    productCandidates: (snapshot.productCandidates ?? []).map(({ id, title }) => ({ id: id.trim(), title: title.trim() })),
    allowedTextSlots: template?.overrideSurface.textSlots ?? [],
  });
  if (Buffer.byteLength(providerInput, "utf8") > PROVIDER_INPUT_BYTE_CAP) invalid();
  const raw = await (dependencies.provider ?? anthropicProvider)({
    system: SYSTEM_PROMPT,
    prompt: providerInput,
    maxOutputChars: PROVIDER_OUTPUT_CHAR_CAP,
    referenceImages: snapshot.referenceImages ?? [],
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (typeof raw !== "string") invalid();
  return parseIntent(raw, snapshot);
}
