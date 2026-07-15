import { afterEach, describe, expect, it, vi } from "vitest";
import {
  estimateGeminiImageCost,
  generateGeminiImages,
  ImageGenerationQuotaError,
  type GeminiImageMeter,
} from "./gemini.server";

afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_IMAGE_GENERATION_ENABLED;
});

function meter(eventIds: string[]): GeminiImageMeter {
  return {
    reserve: vi.fn(async () => ({ ok: true as const, eventIds })),
    started: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

const baseInput = {
  shopId: "11111111-1111-1111-1111-111111111111",
  purpose: "campaign_initial" as const,
};

describe("generateGeminiImages", () => {
  it("returns inline image data and stores provider usage without exposing the key", async () => {
    process.env.GEMINI_API_KEY = "secret";
    process.env.GEMINI_IMAGE_GENERATION_ENABLED = "1";
    const imageMeter = meter(["evt-1"]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "int-1",
          steps: [
            {
              type: "model_output",
              content: [
                {
                  type: "image",
                  mime_type: "image/jpeg",
                  data: "aGVsbG8=",
                },
              ],
            },
          ],
          usage: {
            total_input_tokens: 260,
            total_output_tokens: 1120,
            total_thought_tokens: 0,
            output_tokens_by_modality: [{ modality: "image", tokens: 1120 }],
          },
        }),
        { status: 200 },
      ),
    );

    const [image] = await generateGeminiImages({
      ...baseInput,
      prompt: "A product photo",
      fetchImpl,
      meter: imageMeter,
    });

    expect(image).toBe("data:image/jpeg;base64,aGVsbG8=");
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain("secret");
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      "x-goog-api-key": "secret",
    });
    expect(imageMeter.started).toHaveBeenCalledWith("evt-1");
    expect(imageMeter.complete).toHaveBeenCalledWith("evt-1", {
      status: "succeeded",
      usage: {
        providerRequestId: "int-1",
        inputTokens: 260,
        outputTokens: 1120,
        thoughtTokens: 0,
        estimatedCostUsdMicros: 33665,
      },
    });
  });

  it("keeps successful billed images when a sibling request fails", async () => {
    process.env.GEMINI_API_KEY = "secret";
    process.env.GEMINI_IMAGE_GENERATION_ENABLED = "1";
    const imageMeter = meter(["evt-1", "evt-2"]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            steps: [
              {
                type: "model_output",
                content: [
                  {
                    type: "image",
                    mime_type: "image/jpeg",
                    data: "aW1hZ2U=",
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      );

    await expect(
      generateGeminiImages({
        ...baseInput,
        prompt: "product",
        count: 2,
        fetchImpl,
        meter: imageMeter,
      }),
    ).resolves.toEqual(["data:image/jpeg;base64,aW1hZ2U="]);
    expect(imageMeter.complete).toHaveBeenCalledWith(
      "evt-1",
      expect.objectContaining({ status: "failed" }),
    );
    expect(imageMeter.complete).toHaveBeenCalledWith(
      "evt-2",
      expect.objectContaining({ status: "succeeded" }),
    );
  });

  it("blocks before the provider when the shared quota is exhausted", async () => {
    process.env.GEMINI_API_KEY = "secret";
    process.env.GEMINI_IMAGE_GENERATION_ENABLED = "1";
    const imageMeter = meter([]);
    vi.mocked(imageMeter.reserve).mockResolvedValue({
      ok: false,
      scope: "global",
      limit: 30,
    });
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      generateGeminiImages({
        ...baseInput,
        prompt: "product",
        fetchImpl,
        meter: imageMeter,
      }),
    ).rejects.toBeInstanceOf(ImageGenerationQuotaError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("estimateGeminiImageCost", () => {
  it("falls back to the documented 1K image token count", () => {
    expect(estimateGeminiImageCost({})).toMatchObject({
      outputTokens: 1120,
      estimatedCostUsdMicros: 33600,
    });
  });
});
