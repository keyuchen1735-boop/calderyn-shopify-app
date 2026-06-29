// app/lib/storegen/imagery/provider.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getImageProvider, type ImageProvider } from "./provider";

beforeEach(() => { delete process.env.STOREGEN_IMAGE_PROVIDER; });

describe("ImageProvider seam", () => {
  it("a fake provider satisfies the interface and returns a url", async () => {
    const fake: ImageProvider = { name: "fake", generateListingImage: vi.fn(async () => ({ url: "https://img/x.png" })) };
    const out = await fake.generateListingImage({ productTitle: "Widget", productDescription: "", sourceImageUrl: null, mode: "product_shot" });
    expect(out.url).toBe("https://img/x.png");
  });
  it("getImageProvider returns the higgsfield provider by default", () => {
    expect(getImageProvider().name).toBe("higgsfield");
  });
});
