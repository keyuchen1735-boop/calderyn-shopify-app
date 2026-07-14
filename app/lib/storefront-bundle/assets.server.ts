import { createHash } from "node:crypto";
import { MAX_IMAGE_BYTES, SHOP_ASSETS_BUCKET, sniffImageMime } from "~/lib/assets/persist.server";
import { getSupabase } from "~/lib/supabase.server";
import { assertStorefrontWriteAllowed, StorefrontReleaseError } from "./release.server";
import type { AssetManifest } from "./types";

const HASH_RE = /^[a-f0-9]{64}$/i;
const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "font/woff2": "woff2",
  "image/svg+xml": "svg",
};

export function storefrontAssetKey(shopId: string, contentHash: string, mediaType: string): string {
  if (!HASH_RE.test(contentHash)) throw new Error("content hash must be a 64-character SHA-256 hex digest");
  const extension = EXTENSION[mediaType];
  if (!extension) throw new Error(`unsupported storefront asset media type: ${mediaType}`);
  return `${shopId}/storefront/sha256/${contentHash.toLowerCase()}.${extension}`;
}

async function assetRpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(name, params);
  if (error) {
    throw new StorefrontReleaseError("storefront_asset_write_failed", error.message, 500, error);
  }
  return data as T;
}

export interface VerifiedStorefrontAssetInput {
  shopId: string;
  assetKey?: string;
  contentHash: string;
  mediaType: string;
  byteSize: number;
}

export async function recordVerifiedStorefrontAsset(input: VerifiedStorefrontAssetInput): Promise<string> {
  await assertStorefrontWriteAllowed(input.shopId);
  const assetKey = storefrontAssetKey(input.shopId, input.contentHash, input.mediaType);
  if (input.assetKey !== undefined && input.assetKey !== assetKey) {
    throw new StorefrontReleaseError("storefront_asset_key_mismatch", "Asset key does not match its immutable content identity", 422);
  }
  await assetRpc("record_storefront_verified_asset", {
    p_shop_id: input.shopId,
    p_asset_key: assetKey,
    p_content_hash: input.contentHash,
    p_media_type: input.mediaType,
    p_byte_size: input.byteSize,
  });
  return assetKey;
}

export interface PersistStorefrontAssetBytesInput {
  shopId: string;
  bytes: Uint8Array;
}

export interface PersistedStorefrontAsset {
  assetKey: string;
  contentHash: string;
  mediaType: string;
  byteSize: number;
}

/**
 * Persist already-bounded generated/uploaded image bytes. The existing owned-
 * asset sniffer remains the authority; the object key is immutable and its DB
 * row is marked verified only after Storage accepts the bytes.
 */
export async function persistStorefrontAssetBytes(input: PersistStorefrontAssetBytesInput): Promise<PersistedStorefrontAsset> {
  await assertStorefrontWriteAllowed(input.shopId);
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`storefront asset must be between 1 and ${MAX_IMAGE_BYTES} bytes`);
  }
  const mediaType = sniffImageMime(input.bytes);
  if (!mediaType) throw new Error("unsupported storefront asset bytes");
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const assetKey = storefrontAssetKey(input.shopId, contentHash, mediaType);
  const storage = getSupabase().storage.from(SHOP_ASSETS_BUCKET);
  const uploaded = await storage.upload(assetKey, input.bytes, { contentType: mediaType, upsert: false });
  const alreadyExists = uploaded.error != null &&
    (/already exists|duplicate/i.test(uploaded.error.message) || String((uploaded.error as { statusCode?: unknown }).statusCode) === "409");
  if (uploaded.error && !alreadyExists) {
    throw new StorefrontReleaseError("storefront_asset_upload_failed", uploaded.error.message, 500, uploaded.error);
  }
  try {
    await recordVerifiedStorefrontAsset({
      shopId: input.shopId,
      assetKey,
      contentHash,
      mediaType,
      byteSize: input.bytes.byteLength,
    });
  } catch (error) {
    if (!alreadyExists) await storage.remove([assetKey]).catch(() => undefined);
    throw error;
  }
  return { assetKey, contentHash, mediaType, byteSize: input.bytes.byteLength };
}

export async function attachVerifiedStorefrontAsset(input: {
  shopId: string;
  bundleId: string;
  logicalKey: string;
  assetKey: string;
}): Promise<void> {
  await assertStorefrontWriteAllowed(input.shopId);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.logicalKey)) {
    throw new StorefrontReleaseError("invalid_storefront_asset_logical_key", "Asset logical key is invalid", 422);
  }
  await assetRpc("attach_storefront_bundle_asset", {
    p_shop_id: input.shopId,
    p_bundle_id: input.bundleId,
    p_logical_key: input.logicalKey,
    p_asset_key: input.assetKey,
  });
}

/**
 * Copy immutable asset provenance from one validated version into a custom
 * candidate. The database verifies both owned object metadata and pinned
 * recipe-static identities; callers never choose the copied object keys.
 */
export async function cloneStorefrontBundleAssetProvenance(input: {
  shopId: string;
  sourceVersionId: string;
  targetVersionId: string;
}): Promise<void> {
  await assertStorefrontWriteAllowed(input.shopId);
  await assetRpc("clone_storefront_bundle_asset_provenance", {
    p_shop_id: input.shopId,
    p_source_bundle_id: input.sourceVersionId,
    p_target_bundle_id: input.targetVersionId,
  });
}

const STOREFRONT_ASSET_URL_TTL_SECONDS = 60 * 60;

export async function resolveVerifiedStorefrontAssetUrls(input: {
  shopId: string;
  bundleId: string;
  manifest: AssetManifest;
}): Promise<Readonly<Record<string, string>>> {
  if (input.manifest.entries.length === 0) return {};
  const manifest = new Map(input.manifest.entries.map((entry) => [entry.key, entry]));
  const client = getSupabase();
  const references = await client
    .from("storefront_bundle_asset")
    .select("logical_key, asset_key, status, storefront_asset_object!inner(content_hash, media_type, byte_size, state)")
    .eq("shop_id", input.shopId)
    .eq("bundle_id", input.bundleId)
    .in("logical_key", [...manifest.keys()]);
  if (references.error) {
    throw new StorefrontReleaseError("storefront_asset_read_failed", references.error.message, 500, references.error);
  }
  const objectKeys = new Map<string, string>();
  for (const row of references.data ?? []) {
    const logicalKey = typeof row.logical_key === "string" ? row.logical_key : "";
    const assetKey = typeof row.asset_key === "string" ? row.asset_key : "";
    const metadataValue = row.storefront_asset_object;
    const metadata = Array.isArray(metadataValue) ? metadataValue[0] : metadataValue;
    const expected = manifest.get(logicalKey);
    if (!expected || !assetKey || !metadata || typeof metadata !== "object") continue;
    const record = metadata as Record<string, unknown>;
    if ((row.status !== "verified" && row.status !== "locked") || record.state !== "verified" ||
      record.content_hash !== expected.contentHash || record.media_type !== expected.mediaType ||
      Number(record.byte_size) !== expected.byteSize) continue;
    objectKeys.set(logicalKey, assetKey);
  }
  if (objectKeys.size !== manifest.size) {
    throw new StorefrontReleaseError("storefront_asset_manifest_mismatch", "Custom storefront assets are incomplete", 500);
  }
  const signed = await client.storage.from(SHOP_ASSETS_BUCKET)
    .createSignedUrls([...objectKeys.values()], STOREFRONT_ASSET_URL_TTL_SECONDS);
  if (signed.error) {
    throw new StorefrontReleaseError("storefront_asset_sign_failed", signed.error.message, 503, signed.error);
  }
  const signedByPath = new Map((signed.data ?? []).flatMap((row) =>
    row?.path && row.signedUrl ? [[row.path, row.signedUrl] as const] : []));
  const urls = Object.fromEntries([...objectKeys].flatMap(([logicalKey, assetKey]) => {
    const url = signedByPath.get(assetKey);
    return url ? [[logicalKey, url]] : [];
  }));
  if (Object.keys(urls).length !== manifest.size) {
    throw new StorefrontReleaseError("storefront_asset_sign_failed", "Custom storefront asset signing was incomplete", 503);
  }
  return urls;
}

export async function beginStorefrontAssetGarbageCollection(input: { shopId: string; assetKey: string }): Promise<number | null> {
  return assetRpc<number | null>("begin_storefront_asset_gc", { p_shop_id: input.shopId, p_asset_key: input.assetKey });
}

export async function deleteStorefrontAssetGeneration(input: {
  shopId: string;
  assetKey: string;
  expectedGeneration: number;
}): Promise<boolean> {
  const verified = await assetRpc<boolean>("verify_storefront_asset_gc", {
    p_shop_id: input.shopId,
    p_asset_key: input.assetKey,
    p_expected_generation: input.expectedGeneration,
  });
  if (!verified) return false;
  const removed = await getSupabase().storage.from(SHOP_ASSETS_BUCKET).remove([input.assetKey]);
  if (removed.error) {
    throw new StorefrontReleaseError("storefront_asset_delete_failed", removed.error.message, 503, removed.error);
  }
  return finalizeStorefrontAssetGarbageCollection(input);
}

export async function finalizeStorefrontAssetGarbageCollection(input: {
  shopId: string;
  assetKey: string;
  expectedGeneration: number;
}): Promise<boolean> {
  return assetRpc<boolean>("finalize_storefront_asset_gc", {
    p_shop_id: input.shopId,
    p_asset_key: input.assetKey,
    p_expected_generation: input.expectedGeneration,
  });
}
