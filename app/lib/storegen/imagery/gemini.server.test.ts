import { afterEach, describe, expect, it, vi } from "vitest";
import { generateGeminiImages } from "./gemini.server";

afterEach(() => { delete process.env.GEMINI_API_KEY; });

describe("generateGeminiImages", () => {
  it("returns Gemini inline image data without exposing the API key in the URL", async () => {
    process.env.GEMINI_API_KEY = "secret";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: "aGVsbG8=" }] }],
    }), { status: 200 }));
    const [image] = await generateGeminiImages({ prompt: "A product photo", fetchImpl });
    expect(image).toBe("data:image/jpeg;base64,aGVsbG8=");
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain("secret");
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ "x-goog-api-key": "secret" });
  });
  it("keeps successful billed images when a sibling request fails", async () => {
    process.env.GEMINI_API_KEY = "secret";
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/jpeg", data: "aW1hZ2U=" }] }],
      }), { status: 200 }));
    await expect(generateGeminiImages({ prompt: "product", count: 2, fetchImpl })).resolves.toEqual([
      "data:image/jpeg;base64,aW1hZ2U=",
    ]);
  });
});
