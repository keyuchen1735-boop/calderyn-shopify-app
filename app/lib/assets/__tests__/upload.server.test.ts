import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as PersistModule from "../persist.server";
import { persistUploadedImage, MAX_UPLOAD_BYTES } from "../upload.server";

const { storeMock } = vi.hoisted(() => ({ storeMock: vi.fn() }));

// Mock only storeImageBytes (the Storage/DB boundary); keep the real
// sniffImageMime + MAX_IMAGE_BYTES so the validation is exercised for real.
vi.mock("../persist.server", async (importActual) => {
  const actual = await importActual<typeof PersistModule>();
  return { ...actual, storeImageBytes: storeMock };
});

const SHOP = "11111111-1111-1111-1111-111111111111";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

beforeEach(() => {
  storeMock.mockReset().mockResolvedValue({ assetId: "a1", publicUrl: "https://sb.co/public/shop-assets/k.png", storageKey: "k.png" });
});

describe("persistUploadedImage", () => {
  it("stores a valid png and returns the owned url + sniffed mime", async () => {
    const out = await persistUploadedImage(SHOP, { bytes: PNG, declaredType: "image/png" });
    expect(out).toMatchObject({ assetId: "a1", mime: "image/png" });
    expect(out.publicUrl).toContain("/public/shop-assets/");
    expect(storeMock).toHaveBeenCalledWith(SHOP, PNG, { kind: "upload", source: "upload", mime: "image/png" });
  });

  it("rejects an empty file (422) without storing", async () => {
    await expect(persistUploadedImage(SHOP, { bytes: new Uint8Array(0) })).rejects.toMatchObject({ code: "empty_file", status: 422 });
    expect(storeMock).not.toHaveBeenCalled();
  });

  it("rejects a file over the 10 MB cap (413) without storing", async () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PNG);
    await expect(persistUploadedImage(SHOP, { bytes: big })).rejects.toMatchObject({ code: "file_too_large", status: 413 });
    expect(storeMock).not.toHaveBeenCalled();
  });

  it("rejects a non-image by SNIFFING the bytes, ignoring a spoofed image content-type (415)", async () => {
    await expect(persistUploadedImage(SHOP, { bytes: PDF, declaredType: "image/png" })).rejects.toMatchObject({ code: "unsupported_type", status: 415 });
    expect(storeMock).not.toHaveBeenCalled();
  });
});
