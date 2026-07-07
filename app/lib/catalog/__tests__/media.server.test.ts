import { describe, it, expect, vi, beforeEach } from "vitest";
const upload = vi.fn().mockResolvedValue({ error: null });
const single = vi.fn().mockResolvedValue({ data: { id: "m1" }, error: null });
const insert = vi.fn(() => ({ select: () => ({ single }) }));
const mediaUpdate = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }));
// Owner-lookup result, configurable so we can exercise the not-owned rejection.
let ownerResult: { data: unknown; error: null } = { data: { id: "p1" }, error: null };
// Count of EXISTING bucket images (storage_path NOT NULL) for the product.
let bucketCount = 0;
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    storage: { from: () => ({ upload }) },
    from: (table: string) => {
      if (table === "product_dim") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(ownerResult) }) }) }) };
      }
      // product_media: the primary-count query filters to storage_path NOT NULL
      // (.select().eq().not()); the demote is .update().eq().eq().
      return {
        insert,
        select: () => ({ eq: () => ({ not: () => Promise.resolve({ count: bucketCount, error: null }) }) }),
        update: mediaUpdate,
      };
    },
  }),
}));

beforeEach(() => { upload.mockClear(); insert.mockClear(); mediaUpdate.mockClear(); ownerResult = { data: { id: "p1" }, error: null }; bucketCount = 0; });

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

  it("makes the first BUCKET image primary and demotes a prior (imported) primary", async () => {
    // Imported product: the editor's media list is empty (external rows filtered
    // out), so bucketCount = 0 and the first uploaded image must become primary.
    bucketCount = 0;
    const { uploadProductMedia } = await import("../media.server");
    await uploadProductMedia("shop1", "p1", { bytes: new Uint8Array([1, 2]), filename: "tee.png", contentType: "image/png" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ is_primary: true }));
    expect(mediaUpdate).toHaveBeenCalledWith({ is_primary: false });
  });

  it("does not make a later bucket image primary and does not demote", async () => {
    bucketCount = 2;
    const { uploadProductMedia } = await import("../media.server");
    await uploadProductMedia("shop1", "p1", { bytes: new Uint8Array([1, 2]), filename: "tee.png", contentType: "image/png" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ is_primary: false }));
    expect(mediaUpdate).not.toHaveBeenCalled();
  });
});
