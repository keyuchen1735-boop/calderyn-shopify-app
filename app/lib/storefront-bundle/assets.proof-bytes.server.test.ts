import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadVerifiedStorefrontAssetProofBytes } from "./assets.server";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const hash = createHash("sha256").update(png).digest("hex");
const mocks = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, download: vi.fn() }));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => {
      const query: Record<string, unknown> = {};
      const chain = () => query;
      Object.assign(query, {
        select: chain,
        eq: chain,
        in: chain,
        abortSignal: chain,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: mocks.rows, error: null }).then(resolve),
      });
      return query;
    },
    storage: { from: () => ({ download: mocks.download }) },
  }),
}));

beforeEach(() => {
  mocks.rows = [{
    logical_key: "hero",
    asset_key: "shop/storefront/sha256/object.png",
    status: "locked",
    storefront_asset_object: { content_hash: hash, media_type: "image/png", byte_size: png.byteLength, state: "verified" },
  }];
  mocks.download.mockReset().mockResolvedValue({ data: new Blob([png], { type: "image/png" }), error: null });
});

describe("historic custom asset proof bytes", () => {
  const input = {
    shopId: "11111111-1111-4111-8111-111111111111",
    bundleId: "22222222-2222-4222-8222-222222222222",
    manifest: { entries: [{ key: "hero", contentHash: hash, mediaType: "image/png", byteSize: png.byteLength }] },
  };

  it("downloads and re-verifies exact immutable bytes for browser proof", async () => {
    await expect(loadVerifiedStorefrontAssetProofBytes(input)).resolves.toEqual([{
      key: "hero",
      logicalKey: "hero",
      contentHash: hash,
      mediaType: "image/png",
      byteSize: png.byteLength,
      bytes: png,
    }]);
    expect(mocks.download).toHaveBeenCalledWith("shop/storefront/sha256/object.png");
  });

  it("fails closed when downloaded bytes do not match verified metadata", async () => {
    mocks.download.mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    await expect(loadVerifiedStorefrontAssetProofBytes(input)).rejects.toMatchObject({ code: "storefront_asset_bytes_mismatch" });
  });
});
