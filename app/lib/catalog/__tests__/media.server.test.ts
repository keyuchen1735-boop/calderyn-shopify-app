import { describe, it, expect, vi, beforeEach } from "vitest";
const upload = vi.fn().mockResolvedValue({ error: null });
const single = vi.fn().mockResolvedValue({ data: { id: "m1" }, error: null });
const insert = vi.fn(() => ({ select: () => ({ single }) }));
// Owner-lookup result, configurable so we can exercise the not-owned rejection.
let ownerResult: { data: unknown; error: null } = { data: { id: "p1" }, error: null };
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    storage: { from: () => ({ upload }) },
    from: (table: string) => {
      if (table === "product_dim") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(ownerResult) }) }) }) };
      }
      // product_media
      return { insert, select: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) };
    },
  }),
}));

beforeEach(() => { upload.mockClear(); insert.mockClear(); ownerResult = { data: { id: "p1" }, error: null }; });

describe("uploadProductMedia", () => {
  it("rejects a non-image file", async () => {
    const { uploadProductMedia } = await import("../media.server");
    await expect(uploadProductMedia("shop1", "p1", { bytes: new Uint8Array([1]), filename: "x.pdf", contentType: "application/pdf" }))
      .rejects.toThrow();
  });
  it("rejects attaching media to a product the shop does not own (no upload)", async () => {
    ownerResult = { data: null, error: null };
    const { uploadProductMedia } = await import("../media.server");
    await expect(uploadProductMedia("shop1", "p1", { bytes: new Uint8Array([1, 2]), filename: "tee.png", contentType: "image/png" }))
      .rejects.toThrow("product_not_found");
    expect(upload).not.toHaveBeenCalled();
  });
  it("uploads an image and records the row", async () => {
    const { uploadProductMedia } = await import("../media.server");
    const res = await uploadProductMedia("shop1", "p1", { bytes: new Uint8Array([1, 2]), filename: "tee.png", contentType: "image/png" });
    expect(res.id).toBe("m1");
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
