import { generateGeminiImages } from "~/lib/storegen/imagery/gemini.server";
import type { CreativeGenerator, GenerateRequest } from "./generate.server";
import type { GeneratedCandidate } from "./types";

export type GenerateImageFn = (args: { prompt: string; referenceImageUrl: string | null; count: number }) => Promise<string[]>;

export function geminiImageClient(): GenerateImageFn {
  return ({ prompt, referenceImageUrl, count }) => generateGeminiImages({ prompt, referenceImageUrl, count });
}

export function buildImagePrompt(req: GenerateRequest): string {
  const weak = req.weakMetrics.length
    ? req.weakMetrics.map((m) => `- ${m.label} (${m.score}/100): ${m.reasoning}`).join("\n")
    : "- (no specific weak dimensions flagged)";
  const refs = req.styleRefs.length ? `\nMatch the look of the merchant's winning ads: ${req.styleRefs.join(", ")}.` : "";
  return [
    "Generate an improved advertising image for this product, keeping the same product",
    "identity as the reference image — do NOT invent a different product.",
    `\nHeadline context: ${req.input.headline}`,
    `Audience: ${req.input.audience}`,
    `\nFix these weak dimensions:\n${weak}`,
    req.tips.length ? `\nApply these fixes: ${req.tips.join("; ")}` : "",
    refs,
    req.extraDirection ? `\nArt direction from the merchant: ${req.extraDirection}` : "",
  ].join("\n");
}

export function imageGenerator(deps: { generateImage: GenerateImageFn }): CreativeGenerator {
  return {
    mode: "image",
    available: () => Boolean(process.env.GEMINI_API_KEY),
    async generate(req): Promise<GeneratedCandidate[]> {
      const urls = await deps.generateImage({ prompt: buildImagePrompt(req), referenceImageUrl: req.input.imageUrl, count: req.count });
      const targeted = req.weakMetrics.map((m) => m.label).join(", ") || "overall creative quality";
      return urls.map((url) => ({
        input: { ...req.input, imageUrl: url, mediaKind: "image" as const, videoFrameUrls: [], videoDurationSec: null },
        rationale: `New image targeting: ${targeted}.`,
      }));
    },
  };
}
