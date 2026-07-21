// app/lib/storegen/imagery/provider.server.test.ts
import { beforeEach, describe, it, expect, vi } from "vitest";
import { getImageProvider, type ImageProvider } from "./provider.server";

const { generateGeminiImages } = vi.hoisted(() => ({
  generateGeminiImages: vi.fn(),
}));
vi.mock("./gemini.server", () => ({ generateGeminiImages }));

beforeEach(() => {
  vi.clearAllMocks();
  generateGeminiImages.mockResolvedValue(["https://owned.example/image.jpg"]);
});

describe("ImageProvider seam", () => {
  it("a fake provider satisfies the interface and returns a url", async () => {
    const fake: ImageProvider = {
      name: "fake",
      generateListingImage: vi.fn(async () => ({ url: "https://img/x.png" })),
    };
    const out = await fake.generateListingImage({
      shopId: "11111111-1111-1111-1111-111111111111",
      productTitle: "Widget",
      productDescription: "",
      sourceImageUrl: null,
      mode: "product_shot",
    });
    expect(out.url).toBe("https://img/x.png");
  });
  it("getImageProvider returns the gemini provider by default", () => {
    expect(getImageProvider().name).toBe("gemini");
  });

  it("keeps shared callers opted out and forwards an explicit designer retry", async () => {
    const provider = getImageProvider();
    const request = {
      shopId: "11111111-1111-1111-1111-111111111111",
      productTitle: "Widget",
      productDescription: "",
      sourceImageUrl: null,
      mode: "product_shot" as const,
    };

    await provider.generateListingImage(request);
    expect(generateGeminiImages).toHaveBeenLastCalledWith(
      expect.objectContaining({ retryOnRateLimit: undefined }),
    );

    await provider.generateListingImage({ ...request, retryOnRateLimit: true });
    expect(generateGeminiImages).toHaveBeenLastCalledWith(
      expect.objectContaining({ retryOnRateLimit: true }),
    );
  });
});
