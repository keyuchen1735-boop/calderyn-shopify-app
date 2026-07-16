import { assistantModel, getAnthropic } from "~/lib/assistant/anthropic.server";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";
import {
  STOREFRONT_REFERENCE_MEDIA_TYPES,
  type StorefrontAiProvider,
  type StructuredModelRequest,
  type StructuredModelResponse,
} from "./contracts";

/** Concrete model ids behind the merchant's design-model picker, mirroring the
 *  legacy designer's allowlist: the request only ever selects a key, never a
 *  free-form model id, so a request cannot bill an arbitrary model. */
export const STOREFRONT_DESIGN_MODEL_IDS: Record<StudioDesignModel, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
};

const RESULT_TOOL = "storefront_compiler_result";
const MAX_IMAGE_EVIDENCE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EVIDENCE_COUNT = 8;
const IMAGE_EVIDENCE_MEDIA_TYPES: ReadonlySet<string> = new Set(STOREFRONT_REFERENCE_MEDIA_TYPES);

interface AnthropicLike {
  messages: {
    create(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<{
      content: Array<Record<string, unknown>>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string | null;
    }>;
  };
}

export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export interface AnthropicStructuredProviderOptions {
  client?: AnthropicLike;
  model?: string;
  maxTokens?: number;
}

export function createAnthropicStructuredProvider(
  options: AnthropicStructuredProviderOptions = {},
): StorefrontAiProvider {
  const client = options.client ?? (getAnthropic() as unknown as AnthropicLike);
  // The storefront compiler prompt is far more contract-heavy than assistant
  // chat; STOREFRONT_AI_MODEL lets ops upgrade this pipeline independently.
  const model = options.model ?? (process.env.STOREFRONT_AI_MODEL || assistantModel());
  return {
    async complete(request: StructuredModelRequest): Promise<StructuredModelResponse> {
      if (request.signal?.aborted) throw new DOMException("Generation cancelled", "AbortError");
      const images = request.images ?? [];
      if (images.length > MAX_IMAGE_EVIDENCE_COUNT || images.some((image) =>
        !/^[A-Za-z0-9_-]{1,80}$/.test(image.key) || image.bytes.byteLength === 0 ||
        image.bytes.byteLength > MAX_IMAGE_EVIDENCE_BYTES || !IMAGE_EVIDENCE_MEDIA_TYPES.has(image.mediaType)
      )) throw new StructuredOutputError("Image evidence is invalid or exceeds its bounded limit");
      const content = images.length === 0
        ? request.prompt
        : [
            { type: "text", text: request.prompt },
            ...images.flatMap((image) => [
              { type: "text", text: `IMAGE_REF:${image.key}` },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mediaType,
                  data: Buffer.from(image.bytes).toString("base64"),
                },
              },
            ]),
          ];
      const response = await client.messages.create({
        model,
        max_tokens: options.maxTokens ?? 21_000,
        system: request.system,
        messages: [{ role: "user", content }],
        tools: [{
          name: RESULT_TOOL,
          description: `Schema-only result for storefront operation ${request.operation}`,
          input_schema: request.schema,
        }],
        tool_choice: { type: "tool", name: RESULT_TOOL, disable_parallel_tool_use: true },
      }, { signal: request.signal });
      if (response.stop_reason === "max_tokens") {
        throw new StructuredOutputError("Structured storefront output reached the token limit");
      }
      const blocks = response.content ?? [];
      const matching = blocks.filter((block) => block.type === "tool_use" && block.name === RESULT_TOOL);
      if (matching.length !== 1 || blocks.length !== 1) {
        throw new StructuredOutputError("The model must return exactly one forced schema tool result and no prose");
      }
      if (!("input" in matching[0])) throw new StructuredOutputError("The structured tool result has no input payload");
      return {
        value: matching[0].input,
        usage: {
          inputTokens: Math.max(0, Number(response.usage?.input_tokens ?? 0)),
          outputTokens: Math.max(0, Number(response.usage?.output_tokens ?? 0)),
        },
        provider: "anthropic",
        model,
      };
    },
  };
}
