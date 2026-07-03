// Chat-box attachments become catalog products: one image in, one draft
// product (titled from the filename) with that image attached.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { addProductFromImage, productTitleFromFilename } from "./store-client";

// vi.mock is hoisted above the imports by vitest at transform time, so the
// client mock still applies even though it is written below them.
const { saveProduct, uploadProductImage } = vi.hoisted(() => ({
  saveProduct: vi.fn(),
  uploadProductImage: vi.fn(),
}));

vi.mock("./client", () => ({
  apiGet: vi.fn(),
  apiSend: vi.fn(),
  saveProduct,
  uploadProductImage,
  DashboardApiError: class extends Error {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  saveProduct.mockResolvedValue({ id: "prod-1" });
  uploadProductImage.mockResolvedValue({ id: "media-1", url: "https://x/img.jpg" });
});

describe("addProductFromImage", () => {
  it("creates a draft product titled from the filename and attaches the image", async () => {
    const file = new File(["x"], "red-ceramic-mug.jpg", { type: "image/jpeg" });
    const out = await addProductFromImage(file);
    expect(saveProduct).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Red ceramic mug", status: "draft" }),
    );
    expect(uploadProductImage).toHaveBeenCalledWith("prod-1", file);
    expect(out).toEqual({ id: "prod-1", title: "Red ceramic mug" });
  });

  it("surfaces a partial add (product created, image failed) instead of reporting total failure", async () => {
    uploadProductImage.mockRejectedValue(new Error("unsupported_media_type"));
    const file = new File(["x"], "photo.heic", { type: "image/heic" });
    const out = await addProductFromImage(file);
    expect(saveProduct).toHaveBeenCalledTimes(1);
    expect(out.id).toBe("prod-1");
    expect(out.imageError).toBeTruthy();
  });
});

describe("productTitleFromFilename", () => {
  it("turns a filename into a humane product title", () => {
    expect(productTitleFromFilename("red-ceramic_mug.v2.jpg")).toBe("Red ceramic mug v2");
  });

  it("falls back to a generic title for unusable names", () => {
    expect(productTitleFromFilename("...jpg")).toBe("New product");
    expect(productTitleFromFilename("")).toBe("New product");
  });
});
