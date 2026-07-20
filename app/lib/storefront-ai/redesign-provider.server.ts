import type Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { assistantModel, getAnthropic } from "../assistant/anthropic.server";
import {
  STOREFRONT_REFERENCE_MEDIA_TYPES,
  type StorefrontReferenceMediaType,
} from "./contracts";
import {
  parseRedesignJson,
  parseRedesignProviderAudit,
  type RedesignProviderAudit,
} from "./redesign-schema.server";

const MAX_REFERENCE_IMAGES = 4;
const REFERENCE_URL_CODE_POINT_CAP = 2_048;
const MAX_PROVIDER_TOKENS = 24_000;

export interface RedesignProviderRequest<T> {
  system: string;
  prompt: string;
  schema: Record<string, unknown> & { type: "object" };
  parse(value: unknown): T;
  maxTokens: number;
  referenceImages?: ReadonlyArray<{ url: string; mediaType: StorefrontReferenceMediaType }>;
  signal?: AbortSignal;
}

export interface RedesignProviderResult<T> {
  value: T;
  audit: RedesignProviderAudit;
}

function validReferenceImage(value: { url: string; mediaType: StorefrontReferenceMediaType }): boolean {
  if (Array.from(value.url).length > REFERENCE_URL_CODE_POINT_CAP
    || !STOREFRONT_REFERENCE_MEDIA_TYPES.includes(value.mediaType)) return false;
  try { return new URL(value.url).protocol === "https:"; }
  catch { return false; }
}

function providerError(): never {
  throw new Error("Invalid storefront redesign provider response");
}

export async function completeRedesignRequest<T>(request: RedesignProviderRequest<T>): Promise<RedesignProviderResult<T>> {
  const referenceImages = request.referenceImages ?? [];
  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > MAX_PROVIDER_TOKENS
    || referenceImages.length > MAX_REFERENCE_IMAGES || !referenceImages.every(validReferenceImage)) providerError();

  const content: Anthropic.MessageParam["content"] = [
    ...referenceImages.map(({ url }): Anthropic.ImageBlockParam => ({
      type: "image",
      source: { type: "url", url },
    })),
    { type: "text", text: request.prompt },
  ];
  const model = assistantModel();
  const response = await getAnthropic().messages.create({
    model,
    max_tokens: request.maxTokens,
    system: request.system,
    output_config: { format: jsonSchemaOutputFormat(request.schema) },
    messages: [{ role: "user", content }],
  }, { signal: request.signal });
  if (response.content.length !== 1 || response.content[0]?.type !== "text") providerError();
  return {
    value: parseRedesignJson(response.content[0].text, request.parse),
    audit: parseRedesignProviderAudit({
      provider: "anthropic",
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }),
  };
}
