import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachVerifiedStorefrontAsset,
  cloneStorefrontBundleAssetProvenance,
  beginStorefrontAssetGarbageCollection,
  finalizeStorefrontAssetGarbageCollection,
  deleteStorefrontAssetGeneration,
  persistStorefrontAssetBytes,
  recordVerifiedStorefrontAsset,
  storefrontAssetKey,
} from "./assets.server";

const { rpc, hasRunningExperiment, upload, remove } = vi.hoisted(() => ({
  rpc: vi.fn(),
  hasRunningExperiment: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ rpc, storage: { from: () => ({ upload, remove }) } }),
}));
vi.mock("~/lib/experiments/store-experiment.server", () => ({ hasRunningExperiment }));

const SHOP = "11111111-1111-1111-1111-111111111111";
const BUNDLE = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  hasRunningExperiment.mockResolvedValue(false);
  rpc.mockResolvedValue({ data: true, error: null });
  upload.mockResolvedValue({ error: null });
  remove.mockResolvedValue({ error: null });
});

describe("storefront bundle asset repository", () => {
  it("derives immutable shop-scoped content-addressed keys", () => {
    expect(storefrontAssetKey(SHOP, "a".repeat(64), "image/png"))
      .toBe(`${SHOP}/storefront/sha256/${"a".repeat(64)}.png`);
    expect(() => storefrontAssetKey(SHOP, "not-a-hash", "image/png")).toThrow("content hash");
  });

  it("durably records verified metadata and adds a reference through row-locking RPCs", async () => {
    const assetKey = storefrontAssetKey(SHOP, "a".repeat(64), "image/png");
    await expect(recordVerifiedStorefrontAsset({ shopId: SHOP, contentHash: "a".repeat(64), mediaType: "image/png", byteSize: 123 }))
      .resolves.toBe(assetKey);
    await attachVerifiedStorefrontAsset({ shopId: SHOP, bundleId: BUNDLE, logicalKey: "hero", assetKey });
    expect(rpc).toHaveBeenNthCalledWith(1, "record_storefront_verified_asset", expect.objectContaining({ p_asset_key: assetKey, p_byte_size: 123 }));
    expect(rpc).toHaveBeenNthCalledWith(2, "attach_storefront_bundle_asset", expect.objectContaining({
      p_bundle_id: BUNDLE,
      p_logical_key: "hero",
      p_asset_key: assetKey,
    }));
  });

  it("clones only database-verified asset provenance between immutable bundle versions", async () => {
    await cloneStorefrontBundleAssetProvenance({
      shopId: SHOP,
      sourceVersionId: "33333333-3333-3333-3333-333333333333",
      targetVersionId: BUNDLE,
    });
    expect(rpc).toHaveBeenCalledWith("clone_storefront_bundle_asset_provenance", {
      p_shop_id: SHOP,
      p_source_bundle_id: "33333333-3333-3333-3333-333333333333",
      p_target_bundle_id: BUNDLE,
    });
  });

  it("rejects any caller-supplied key that disagrees with the derived immutable key", async () => {
    await expect(recordVerifiedStorefrontAsset({
      shopId: SHOP,
      assetKey: "caller/chosen.png",
      contentHash: "a".repeat(64),
      mediaType: "image/png",
      byteSize: 123,
    })).rejects.toMatchObject({ code: "storefront_asset_key_mismatch" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sniffs, hashes, uploads, and durably verifies bytes under the content-addressed key", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await persistStorefrontAssetBytes({ shopId: SHOP, bytes: png });
    expect(result.mediaType).toBe("image/png");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.assetKey).toContain(`/storefront/sha256/${result.contentHash}.png`);
    expect(upload).toHaveBeenCalledWith(result.assetKey, png, { contentType: "image/png", upsert: false });
    expect(rpc).toHaveBeenCalledWith("record_storefront_verified_asset", expect.objectContaining({
      p_asset_key: result.assetKey,
      p_content_hash: result.contentHash,
      p_byte_size: png.byteLength,
    }));
  });

  it("removes an uploaded object when durable verification fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "db failed" } });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(persistStorefrontAssetBytes({ shopId: SHOP, bytes: png })).rejects.toThrow("db failed");
    expect(remove).toHaveBeenCalledWith([expect.stringContaining("/storefront/sha256/")]);
  });

  it("removes newly uploaded bytes when cancellation wins before metadata verification", async () => {
    const controller = new AbortController();
    upload.mockImplementationOnce(async () => {
      controller.abort(new DOMException("cancelled", "AbortError"));
      return { error: null };
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(persistStorefrontAssetBytes({ shopId: SHOP, bytes: png, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(remove).toHaveBeenCalledWith([expect.stringContaining("/storefront/sha256/")]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propagates the generation token from begin-GC into the final deletion CAS", async () => {
    rpc.mockResolvedValueOnce({ data: 7, error: null }).mockResolvedValueOnce({ data: true, error: null });
    const generation = await beginStorefrontAssetGarbageCollection({ shopId: SHOP, assetKey: "key" });
    expect(generation).toBe(7);
    if (generation === null) throw new Error("expected a GC generation");
    await expect(finalizeStorefrontAssetGarbageCollection({ shopId: SHOP, assetKey: "key", expectedGeneration: generation }))
      .resolves.toBe(true);
    expect(rpc).toHaveBeenLastCalledWith("finalize_storefront_asset_gc", expect.objectContaining({ p_expected_generation: 7 }));
  });

  it("rechecks generation immediately before remove and finalizes only after successful storage deletion", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: true, error: null });
    await expect(deleteStorefrontAssetGeneration({ shopId: SHOP, assetKey: "key", expectedGeneration: 7 }))
      .resolves.toBe(true);
    expect(rpc).toHaveBeenNthCalledWith(1, "verify_storefront_asset_gc", expect.objectContaining({ p_expected_generation: 7 }));
    expect(remove).toHaveBeenCalledWith(["key"]);
    expect(rpc).toHaveBeenNthCalledWith(2, "finalize_storefront_asset_gc", expect.objectContaining({ p_expected_generation: 7 }));
  });

  it("leaves deleting state retryable when Storage removal fails", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    remove.mockResolvedValueOnce({ error: { message: "storage down" } });
    await expect(deleteStorefrontAssetGeneration({ shopId: SHOP, assetKey: "key", expectedGeneration: 7 }))
      .rejects.toMatchObject({ code: "storefront_asset_delete_failed" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
