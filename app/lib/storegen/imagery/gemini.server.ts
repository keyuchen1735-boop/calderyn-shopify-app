import { fetchExternalImageBytes } from "~/lib/assets/persist.server";
import {
  completeImageGen,
  markImageGenStarted,
  releaseImageGen,
  reserveImageGenSlots,
  type ImageGenLimits,
  type ImageGenerationUsage,
} from "~/lib/screener/image-gen-limit.server";

export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-lite-image";
const ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const FALLBACK_IMAGE_OUTPUT_TOKENS = 1120;

export function geminiImageGenerationEnabled(): boolean {
  return /^(?:1|true)$/i.test(process.env.GEMINI_IMAGE_GENERATION_ENABLED ?? "");
}

type GeminiResponse = {
  id?: string;
  model?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; mime_type?: string; data?: string }>;
  }>;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    output_tokens_by_modality?: Array<{
      modality?: string;
      tokens?: number;
    }>;
  };
};

export class ImageGenerationQuotaError extends Error {
  constructor(
    public readonly scope: "shop" | "global",
    public readonly limit: number,
  ) {
    super(`Image generation ${scope} limit reached (${limit})`);
    this.name = "ImageGenerationQuotaError";
  }
}

export interface GeminiImageMeter {
  reserve(input: {
    shopId: string;
    count: number;
    generationId?: string;
    purpose: string;
    /** Per-reservation cap override (e.g. the designer first-build reserve);
     *  omitted = the env-derived daily limits. Counting is never affected. */
    limits?: Partial<ImageGenLimits>;
  }): Promise<
    | { ok: true; eventIds: string[] }
    | { ok: false; scope: "shop" | "global"; limit: number }
  >;
  started(eventId: string): Promise<void>;
  complete(
    eventId: string,
    result:
      | { status: "succeeded"; usage: ImageGenerationUsage }
      | {
          status: "failed";
          errorCode: string;
          usage?: ImageGenerationUsage;
        },
  ): Promise<void>;
  release(eventId: string): Promise<void>;
}

const defaultMeter: GeminiImageMeter = {
  async reserve(input) {
    return reserveImageGenSlots(
      input.shopId,
      input.count,
      new Date(),
      {
        generationId: input.generationId,
        provider: "gemini",
        model: GEMINI_IMAGE_MODEL,
        purpose: input.purpose,
      },
      input.limits,
    );
  },
  started: markImageGenStarted,
  complete: completeImageGen,
  release: releaseImageGen,
};

function nonNegativeInt(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

/** Estimate provider cost in millionths of one USD from Gemini response usage. */
export function estimateGeminiImageCost(
  payload: GeminiResponse,
): ImageGenerationUsage {
  const inputTokens = nonNegativeInt(payload.usage?.total_input_tokens);
  const thoughtTokens = nonNegativeInt(payload.usage?.total_thought_tokens);
  const outputByModality = payload.usage?.output_tokens_by_modality ?? [];
  const imageOutputTokens = outputByModality
    .filter((item) => item.modality === "image")
    .reduce((sum, item) => sum + (nonNegativeInt(item.tokens) ?? 0), 0);
  const textOutputTokens = outputByModality
    .filter((item) => item.modality === "text")
    .reduce((sum, item) => sum + (nonNegativeInt(item.tokens) ?? 0), 0);
  const totalOutputTokens = nonNegativeInt(payload.usage?.total_output_tokens);
  const billedImageTokens =
    imageOutputTokens || totalOutputTokens || FALLBACK_IMAGE_OUTPUT_TOKENS;

  // Standard Gemini 3.1 Flash Lite Image pricing: $0.25/M input tokens,
  // $30/M image output tokens, and $1.50/M text/thinking output tokens.
  const estimatedCostUsdMicros =
    Math.ceil((inputTokens ?? 0) / 4) +
    billedImageTokens * 30 +
    Math.ceil((textOutputTokens + (thoughtTokens ?? 0)) * 1.5);

  return {
    providerRequestId: payload.id ?? null,
    inputTokens,
    outputTokens: billedImageTokens,
    thoughtTokens,
    estimatedCostUsdMicros,
  };
}

async function referencePart(url: string, signal?: AbortSignal) {
  const image = await fetchExternalImageBytes(url, { signal });
  return {
    type: "image",
    mime_type: image.mediaType,
    data: Buffer.from(image.bytes).toString("base64"),
  };
}

export async function generateGeminiImages(input: {
  shopId: string;
  purpose:
    | "campaign_initial"
    | "campaign_regeneration"
    | "storefront_product"
    | "storefront_design";
  generationId?: string;
  prompt: string;
  referenceImageUrl?: string | null;
  count?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  meter?: GeminiImageMeter;
  /** Per-reservation daily-cap override (designer first-build reserve). */
  limits?: Partial<ImageGenLimits>;
  /** One in-slot retry for provider throttling. Designer first builds opt in;
   *  shared/classic callers keep their original single-attempt behavior. */
  retryOnRateLimit?: boolean;
}): Promise<string[]> {
  if (!geminiImageGenerationEnabled()) {
    throw new Error("Live Gemini image generation is disabled");
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key)
    throw new Error(
      "Gemini image generation is not configured (set GEMINI_API_KEY)",
    );
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(40_000)])
    : AbortSignal.timeout(40_000);
  const requestInput: string | Array<Record<string, unknown>> =
    input.referenceImageUrl
      ? [
          { type: "text", text: input.prompt },
          await referencePart(input.referenceImageUrl, signal),
        ]
      : input.prompt;
  const count = Math.max(1, input.count ?? 1);
  const meter = input.meter ?? defaultMeter;
  const reservation = await meter.reserve({
    shopId: input.shopId,
    count,
    generationId: input.generationId,
    purpose: input.purpose,
    limits: input.limits,
  });
  if (!reservation.ok) {
    throw new ImageGenerationQuotaError(reservation.scope, reservation.limit);
  }

  const generateOne = async (eventId: string) => {
    let providerStarted = false;
    try {
      await meter.started(eventId);
      providerStarted = true;
      const attempt = () =>
        (input.fetchImpl ?? fetch)(ENDPOINT, {
          method: "POST",
          headers: {
            "x-goog-api-key": key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: GEMINI_IMAGE_MODEL,
            input: requestInput,
            response_format: {
              type: "image",
              mime_type: "image/jpeg",
              aspect_ratio: "1:1",
              image_size: "1K",
            },
          }),
          signal,
        });
      let response = await attempt();
      // Bounded in-slot retry on provider throttle: exactly one retry, short
      // jittered backoff, INSIDE the already-started (already-counted) event —
      // zero extra ledger rows, and complete() below still fires exactly once
      // with the final outcome. A 429 response carries no image cost, so the
      // deliberate anti-retry-storm counting (failed attempts stay in the
      // daily ceiling) is unaffected.
      if (input.retryOnRateLimit === true && response.status === 429 && !signal.aborted) {
        await new Promise((resolve) =>
          setTimeout(resolve, 2_000 + Math.random() * 2_000),
        );
        if (!signal.aborted) response = await attempt();
      }
      if (!response.ok)
        throw new Error(`Gemini image generation failed (${response.status})`);
      const payload = (await response.json()) as GeminiResponse;
      const image = payload.steps
        ?.filter((step) => step.type === "model_output")
        .flatMap((step) => step.content ?? [])
        .find((part) => part.type === "image" && part.data);
      if (!image?.data || !image.mime_type?.startsWith("image/"))
        throw new Error("Gemini returned no image");
      try {
        await meter.complete(eventId, {
          status: "succeeded",
          usage: estimateGeminiImageCost(payload),
        });
      } catch (trackingError) {
        // Keep the paid image. Its still-reserved ledger row remains counted,
        // so a tracking outage fails the cost ceiling closed.
        console.error("[gemini image] usage tracking failed", trackingError);
      }
      return `data:${image.mime_type};base64,${image.data}`;
    } catch (error) {
      if (providerStarted) {
        try {
          await meter.complete(eventId, {
            status: "failed",
            errorCode:
              error instanceof Error
                ? error.message.slice(0, 160)
                : "provider_failed",
          });
        } catch (trackingError) {
          console.error(
            "[gemini image] failure tracking failed",
            trackingError,
          );
        }
      } else {
        await meter.release(eventId);
      }
      throw error;
    }
  };

  const settled = await Promise.allSettled(
    reservation.eventIds.map(generateOne),
  );
  const images = settled
    .filter(
      (result): result is PromiseFulfilledResult<string> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value);
  if (images.length === 0)
    throw (
      settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )?.reason ?? new Error("Gemini returned no images")
    );
  return images;
}
