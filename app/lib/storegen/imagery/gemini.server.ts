import { fetchExternalImageBytes } from "~/lib/assets/persist.server";

const MODEL = "gemini-3.1-flash-lite-image";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

type GeminiResponse = {
  steps?: Array<{ type?: string; content?: Array<{ type?: string; mime_type?: string; data?: string }> }>;
};

async function referencePart(url: string, signal?: AbortSignal) {
  const image = await fetchExternalImageBytes(url, { signal });
  return { type: "image", mime_type: image.mediaType, data: Buffer.from(image.bytes).toString("base64") };
}

export async function generateGeminiImages(input: {
  prompt: string;
  referenceImageUrl?: string | null;
  count?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Gemini image generation is not configured (set GEMINI_API_KEY)");
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(40_000)])
    : AbortSignal.timeout(40_000);
  const requestInput: string | Array<Record<string, unknown>> = input.referenceImageUrl
    ? [{ type: "text", text: input.prompt }, await referencePart(input.referenceImageUrl, signal)]
    : input.prompt;
  const generateOne = async () => {
    const response = await (input.fetchImpl ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        input: requestInput,
        response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: "1:1", image_size: "1K" },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Gemini image generation failed (${response.status})`);
    const payload = await response.json() as GeminiResponse;
    const image = payload.steps?.filter((step) => step.type === "model_output")
      .flatMap((step) => step.content ?? []).find((part) => part.type === "image" && part.data);
    if (!image?.data || !image.mime_type?.startsWith("image/")) throw new Error("Gemini returned no image");
    return `data:${image.mime_type};base64,${image.data}`;
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, input.count ?? 1) }, generateOne));
  const images = settled.filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
    .map((result) => result.value);
  if (images.length === 0) throw (settled.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason ?? new Error("Gemini returned no images"));
  return images;
}
