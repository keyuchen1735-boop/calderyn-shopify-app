import {
  persistExternalImage,
  type PersistOutcome,
} from "~/lib/assets/persist.server";
import { ImageGenerationQuotaError } from "~/lib/storegen/imagery/gemini.server";
import { resolveShopId } from "~/lib/supabase.server";
import type { CreativeGenerator, GenerateRequest } from "./generate.server";
import type { CreativeInput, GeneratedCandidate } from "./types";

export interface FirstRunDirectionCandidate extends GeneratedCandidate {
  imageGenerated: boolean;
}

export interface FirstRunImageGeneration {
  candidates: GeneratedCandidate[];
  /** True once the paid provider was invoked, even if owned-asset persistence failed. */
  providerAttempted: boolean;
}

/** Model copy is normalized at the server boundary so generated campaign text
 * never leaks typographic long dashes into drafts, previews, or ad payloads. */
export function normalizeGeneratedText(value: string): string {
  return value
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,+/g, ", ")
    .replace(/\s{2,}/g, " ")
    // A dash at the very start or end leaves a dangling ", " once replaced;
    // strip leading/trailing commas and whitespace so copy never renders (or
    // ships to Meta) with a stray comma.
    .replace(/^[\s,]+|[\s,]+$/g, "");
}

function normalizeCreativeTextRecord(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const normalized = { ...record };
  for (const field of ["headline", "primaryText", "rationale"] as const) {
    if (typeof record[field] === "string") {
      normalized[field] = normalizeGeneratedText(record[field]);
    }
  }
  return normalized;
}

/** Normalize both newly built and idempotently replayed wizard responses. */
export function normalizeFirstRunCreativePayload<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  return {
    ...record,
    ...(Object.hasOwn(record, "fallback")
      ? { fallback: normalizeCreativeTextRecord(record.fallback) }
      : {}),
    ...(Array.isArray(record.variants)
      ? { variants: record.variants.map(normalizeCreativeTextRecord) }
      : {}),
  } as T;
}

interface FirstRunImageDeps {
  resolveShop: (shop: string) => Promise<string>;
  persist: (
    shopId: string,
    url: string,
    kind: string,
    source: "generated",
  ) => Promise<PersistOutcome>;
}

const defaultImageDeps: FirstRunImageDeps = {
  resolveShop: resolveShopId,
  persist: persistExternalImage,
};

/**
 * Cost-safe image generation for the wizard. Provider or quota failures are a
 * graceful copy-only fallback; successful URLs are persisted before they leave
 * the server so Review and launch do not depend on an expiring provider URL.
 */
export async function generateFirstRunImages(
  args: {
    shop: string;
    count: number;
    generator: CreativeGenerator;
    request: GenerateRequest;
  },
  deps: FirstRunImageDeps = defaultImageDeps,
): Promise<FirstRunImageGeneration> {
  if (!args.generator.available())
    return { candidates: [], providerAttempted: false };

  let shopId: string;
  try {
    shopId = await deps.resolveShop(args.shop);
  } catch (error) {
    console.error(
      "[first-run creatives] image quota unavailable; using product image",
      error,
    );
    return { candidates: [], providerAttempted: false };
  }
  try {
    const generated = (
      await args.generator.generate({ ...args.request, count: args.count })
    ).slice(0, args.count);
    const persisted = await Promise.all(
      generated.map(async (candidate): Promise<GeneratedCandidate | null> => {
        const url = candidate.input.imageUrl;
        if (!url) return null;
        try {
          const owned = await deps.persist(
            shopId,
            url,
            "campaign-creative",
            "generated",
          );
          if (!owned.persisted) return null;
          return {
            ...candidate,
            input: { ...candidate.input, imageUrl: owned.url },
          };
        } catch (error) {
          console.error(
            "[first-run creatives] generated image persistence failed",
            error,
          );
          return null;
        }
      }),
    );
    return {
      candidates: persisted.filter(
        (candidate): candidate is GeneratedCandidate => candidate !== null,
      ),
      providerAttempted: true,
    };
  } catch (error) {
    console.error(
      "[first-run creatives] image generation failed; using product image",
      error,
    );
    return {
      candidates: [],
      providerAttempted: !(error instanceof ImageGenerationQuotaError),
    };
  }
}

/** Pair independently generated copy and visuals into complete, scoreable ads. */
export function combineFirstRunDirections(
  original: CreativeInput,
  copyCandidates: GeneratedCandidate[],
  imageCandidates: GeneratedCandidate[],
  count: number,
): FirstRunDirectionCandidate[] {
  const total = Math.min(
    count,
    Math.max(copyCandidates.length, imageCandidates.length),
  );
  return Array.from({ length: total }, (_, index) => {
    const copy = copyCandidates[index];
    const image = imageCandidates[index];
    const generatedImageUrl = image?.input.imageUrl ?? null;
    const copyInput = copy?.input ?? original;
    const input: CreativeInput = generatedImageUrl
      ? {
          ...copyInput,
          imageUrl: generatedImageUrl,
          mediaKind: "image",
          videoFrameUrls: [],
          videoDurationSec: null,
        }
      : copyInput;
    return {
      input,
      rationale: [copy?.rationale, image?.rationale].filter(Boolean).join(" "),
      imageGenerated: Boolean(generatedImageUrl),
    };
  });
}
