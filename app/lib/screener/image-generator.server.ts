import { generateGeminiImages, geminiImageGenerationEnabled } from "~/lib/storegen/imagery/gemini.server";
import type { CreativeGenerator, GenerateRequest } from "./generate.server";
import type { GeneratedCandidate } from "./types";

export type GenerateImageFn = (args: { prompt: string; referenceImageUrl: string | null; count: number }) => Promise<string[]>;

export function geminiImageClient(input: {
  shopId: string;
  purpose: "campaign_initial" | "campaign_regeneration";
  generationId: string;
}): GenerateImageFn {
  return ({ prompt, referenceImageUrl, count }) => generateGeminiImages({
    ...input, prompt, referenceImageUrl, count,
  });
}

export function buildImagePrompt(req: GenerateRequest): string {
  const weak = req.weakMetrics.length
    ? req.weakMetrics.map((m) => `- ${m.label} (${m.score}/100): ${m.reasoning}`).join("\n")
    : "- (no specific weak dimensions flagged)";
  const refs = req.styleRefs.length ? `\nMatch the look of the merchant's winning ads: ${req.styleRefs.join(", ")}.` : "";
  const identityDirection = req.input.imageUrl
    ? [
        "Use the reference product image as the source of truth for the product's",
        "shape, materials, colors, proportions, and recognizable details.",
        "Create a new advertising scene around that exact product — do NOT redesign it.",
      ].join(" ")
    : [
        "Create an advertising image for the product described below.",
        "Do not add unsupported features, branding, claims, or a different product.",
      ].join(" ");
  return [
    "Generate an improved advertising image for this product.",
    identityDirection,
    `\nHeadline context: ${req.input.headline}`,
    `Product context: ${req.input.primaryText}`,
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
    available: () => geminiImageGenerationEnabled() && Boolean(process.env.GEMINI_API_KEY),
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
