import { describe, expect, it, vi } from "vitest";
import { designerProductImagesAvailable } from "./product-imagery.server";

describe("designerProductImagesAvailable", () => {
  it("checks every active product beyond the designer context window and accepts ready asset overrides", async () => {
    const ids = Array.from({ length: 13 }, (_, index) => `p${index + 1}`);
    const dependencies = {
      listActiveProductIds: vi.fn().mockResolvedValue(ids),
      listProductMediaIds: vi.fn().mockResolvedValue(ids.slice(0, 12)),
      listReadyAssetIds: vi.fn().mockResolvedValue([]),
    };

    await expect(designerProductImagesAvailable("shop", dependencies)).resolves.toBe(false);
    dependencies.listReadyAssetIds.mockResolvedValue(["p13"]);
    await expect(designerProductImagesAvailable("shop", dependencies)).resolves.toBe(true);
  });

  it("treats an empty catalog as unavailable rather than image-ready", async () => {
    await expect(designerProductImagesAvailable("shop", {
      listActiveProductIds: vi.fn().mockResolvedValue([]),
      listProductMediaIds: vi.fn().mockResolvedValue([]),
      listReadyAssetIds: vi.fn().mockResolvedValue([]),
    })).resolves.toBe(false);
  });
});
