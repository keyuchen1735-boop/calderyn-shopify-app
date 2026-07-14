import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { imageGenerator, type GenerateImageFn } from "../image-generator.server";
import type { GenerateRequest } from "../generate.server";
import type { CreativeInput } from "../types";

const ORIGINAL: CreativeInput = {
  imageUrl: "https://cdn.example/original.png",
  headline: "Glow serum",
  primaryText: "Hydrate overnight.",
  cta: "Shop now",
  destinationUrl: "https://shop.example/serum?utm_content=HYD-30",
  audience: "skincare buyers 25-40",
};

const REQ: GenerateRequest = {
  input: ORIGINAL,
  weakMetrics: [
    { label: "Hook strength", score: 40, reasoning: "No clear focal subject in first frame." },
    { label: "Visual focal clarity", score: 52, reasoning: "Product competes with busy background." },
  ],
  tips: ["Put the bottle on a clean contrasting background."],
  styleRefs: ["Summer Glow", "Morning Routine"],
  count: 2,
};

const KEYS = ["GEMINI_API_KEY"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("imageGenerator", () => {
  it("is an image-mode generator", () => {
    expect(imageGenerator({ generateImage: vi.fn() }).mode).toBe("image");
  });

  it("available() requires the Gemini API key", () => {
    const gen = imageGenerator({ generateImage: vi.fn() });
    expect(gen.available()).toBe(false);
    process.env.GEMINI_API_KEY = "k";
    expect(gen.available()).toBe(true);
  });

  it("builds candidates that swap the image and preserve all copy", async () => {
    const generateImage = vi.fn(async () => [
      "https://cdn.example/new-1.png",
      "https://cdn.example/new-2.png",
    ]);
    const candidates = await imageGenerator({ generateImage }).generate(REQ);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.input.imageUrl)).toEqual([
      "https://cdn.example/new-1.png",
      "https://cdn.example/new-2.png",
    ]);
    for (const c of candidates) {
      expect(c.input.headline).toBe(ORIGINAL.headline);
      expect(c.input.primaryText).toBe(ORIGINAL.primaryText);
      expect(c.input.cta).toBe(ORIGINAL.cta);
      expect(c.input.destinationUrl).toBe(ORIGINAL.destinationUrl);
      expect(c.input.audience).toBe(ORIGINAL.audience);
      expect(c.rationale.length).toBeGreaterThan(0);
    }
  });

  it("turns a VIDEO original into image candidates — stale frames cleared so the gate scores the new image", async () => {
    const generateImage = vi.fn(async () => ["https://cdn.example/new.png"]);
    const videoOriginal: CreativeInput = {
      ...ORIGINAL,
      mediaKind: "video",
      videoFrameUrls: ["data:image/webp;base64,AA"],
      videoDurationSec: 12,
    };
    const [candidate] = await imageGenerator({ generateImage }).generate({
      ...REQ,
      input: videoOriginal,
    });
    expect(candidate.input.mediaKind).toBe("image");
    expect(candidate.input.videoFrameUrls).toEqual([]);
    expect(candidate.input.videoDurationSec).toBeNull();
    expect(candidate.input.imageUrl).toBe("https://cdn.example/new.png");
  });

  it("passes a prompt built from the weak dimensions + tips, the reference image, and count", async () => {
    const generateImage = vi.fn<GenerateImageFn>(async () => ["https://cdn.example/new.png"]);
    await imageGenerator({ generateImage }).generate(REQ);

    expect(generateImage).toHaveBeenCalledTimes(1);
    const arg = generateImage.mock.calls[0][0];
    expect(arg.referenceImageUrl).toBe(ORIGINAL.imageUrl);
    expect(arg.count).toBe(2);
    expect(arg.prompt).toContain("Hook strength");
    expect(arg.prompt).toContain("clean contrasting background");
    expect(arg.prompt).toContain(ORIGINAL.primaryText);
    expect(arg.prompt).toContain("source of truth");
  });

  it("returns no candidates when generation yields no images", async () => {
    const candidates = await imageGenerator({ generateImage: vi.fn(async () => []) }).generate(REQ);
    expect(candidates).toEqual([]);
  });

  it("includes the merchant's extra direction and style preset in the prompt", async () => {
    const generateImage = vi.fn<GenerateImageFn>(async () => ["https://cdn.example/new.png"]);
    await imageGenerator({ generateImage }).generate({
      ...REQ,
      extraDirection: "keep the forest backdrop, golden hour — UGC handheld style",
    });
    const arg = generateImage.mock.calls[0][0];
    expect(arg.prompt).toContain("keep the forest backdrop, golden hour");
    expect(arg.prompt).toContain("UGC handheld");
  });
});
