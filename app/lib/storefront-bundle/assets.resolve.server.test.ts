import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVerifiedStorefrontAssetUrls } from "./assets.server";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  createSignedUrls: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => {
      const query: Record<string, unknown> = {};
      const chain = () => query;
      Object.assign(query, {
        select: chain,
        eq: chain,
        in: chain,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: mocks.rows, error: null }).then(resolve),
      });
      return query;
    },
    storage: { from: () => ({ createSignedUrls: mocks.createSignedUrls }) },
  }),
}));

beforeEach(() => {
  mocks.rows = [{
    logical_key: "hero",
    asset_key: "shop/storefront/sha256/object.webp",
    status: "locked",
    storefront_asset_object: {
      content_hash: "a".repeat(64),
      media_type: "image/webp",
      byte_size: 42,
      state: "verified",
    },
  }];
  mocks.createSignedUrls.mockReset().mockResolvedValue({
    data: [{ path: "shop/storefront/sha256/object.webp", signedUrl: "https://assets.example.test/signed" }],
    error: null,
  });
});

describe("custom storefront asset URL resolution", () => {
  const manifest = {
    entries: [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }],
  };

  it("signs the exact verified object behind each logical compiler key", async () => {
    await expect(resolveVerifiedStorefrontAssetUrls({
      shopId: "11111111-1111-4111-8111-111111111111",
      bundleId: "22222222-2222-4222-8222-222222222222",
      manifest,
    })).resolves.toEqual({ hero: "https://assets.example.test/signed" });
    expect(mocks.createSignedUrls).toHaveBeenCalledWith(["shop/storefront/sha256/object.webp"], 3600);
  });

  it("fails closed before signing when durable metadata differs from the bundle manifest", async () => {
    mocks.rows[0].storefront_asset_object = {
      content_hash: "b".repeat(64),
      media_type: "image/webp",
      byte_size: 42,
      state: "verified",
    };
    await expect(resolveVerifiedStorefrontAssetUrls({
      shopId: "11111111-1111-4111-8111-111111111111",
      bundleId: "22222222-2222-4222-8222-222222222222",
      manifest,
    })).rejects.toMatchObject({ code: "storefront_asset_manifest_mismatch" });
    expect(mocks.createSignedUrls).not.toHaveBeenCalled();
  });
});
