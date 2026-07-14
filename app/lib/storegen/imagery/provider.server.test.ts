// app/lib/storegen/imagery/provider.server.test.ts
import { describe, it, expect, vi } from "vitest";
import { getImageProvider, type ImageProvider } from "./provider.server";

describe("ImageProvider seam", () => {
  it("a fake provider satisfies the interface and returns a url", async () => {
    const fake: ImageProvider = { name: "fake", generateListingImage: vi.fn(async () => ({ url: "https://img/x.png" })) };
    const out = await fake.generateListingImage({ productTitle: "Widget", productDescription: "", sourceImageUrl: null, mode: "product_shot" });
    expect(out.url).toBe("https://img/x.png");
  });
  it("getImageProvider returns the gemini provider by default", () => {
    expect(getImageProvider().name).toBe("gemini");
  });
});
