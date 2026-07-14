import {
  persistExternalImage,
  type PersistOutcome,
} from "~/lib/assets/persist.server";
import { resolveShopId } from "~/lib/supabase.server";
import type { CreativeGenerator, GenerateRequest } from "./generate.server";
import {
  releaseImageGen,
  reserveImageGenSlots,
  type ReserveSlotsResult,
} from "./image-gen-limit.server";
import type { CreativeInput, GeneratedCandidate } from "./types";

export interface FirstRunDirectionCandidate extends GeneratedCandidate {
  imageGenerated: boolean;
}

export interface FirstRunImageGeneration {
  candidates: GeneratedCandidate[];
  /** True once the paid provider was invoked, even if owned-asset persistence failed. */
  providerAttempted: boolean;
}

interface FirstRunImageDeps {
  reserve: (shop: string, count: number) => Promise<ReserveSlotsResult>;
  release: (eventId: string | null) => Promise<void>;
  resolveShop: (shop: string) => Promise<string>;
  persist: (
    shopId: string,
    url: string,
    kind: string,
    source: "generated",
  ) => Promise<PersistOutcome>;
}

const defaultImageDeps: FirstRunImageDeps = {
  reserve: reserveImageGenSlots,
  release: releaseImageGen,
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
  let reserved: ReserveSlotsResult;
  try {
    shopId = await deps.resolveShop(args.shop);
    reserved = await deps.reserve(args.shop, args.count);
  } catch (error) {
    console.error(
      "[first-run creatives] image quota unavailable; using product image",
      error,
    );
    return { candidates: [], providerAttempted: false };
  }
  if (!reserved.ok) return { candidates: [], providerAttempted: false };

  try {
    const generated = (
      await args.generator.generate({ ...args.request, count: args.count })
    ).slice(0, args.count);
    await Promise.all(
      reserved.eventIds
        .slice(generated.length)
        .map((eventId) => deps.release(eventId)),
    );

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
    await Promise.all(
      reserved.eventIds.map((eventId) => deps.release(eventId)),
    );
    console.error(
      "[first-run creatives] image generation failed; using product image",
      error,
    );
    return { candidates: [], providerAttempted: true };
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
