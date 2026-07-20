import type { AssetManifestEntry } from "../storefront-bundle/types";
import { CompilerError } from "./bindings";

const ALLOWED_MEDIA_TYPES = new Set([
  "image/avif",
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "font/woff2",
  "video/webm",
  "video/mp4",
]);
const ASSET_FIELDS = new Set(["key", "contentHash", "mediaType", "byteSize"]);

export function isCompilerIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "-" || character === "_")) return false;
  }
  return true;
}

export function assertValidAssetEntry(value: unknown): asserts value is AssetManifestEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CompilerError("asset.entry", "Asset entry must be an object");
  }
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (keys.length !== ASSET_FIELDS.size || keys.some((key) => !ASSET_FIELDS.has(key))) {
    throw new CompilerError("asset.entry", "Asset entries must contain only compiler-owned metadata fields");
  }
  if (!isCompilerIdentifier(entry.key)) throw new CompilerError("asset.key", "Asset key must be a bounded identifier");
  if (typeof entry.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.contentHash)) {
    throw new CompilerError("asset.hash", `Asset ${entry.key} must use a lowercase SHA-256 digest`);
  }
  if (typeof entry.mediaType !== "string" || !ALLOWED_MEDIA_TYPES.has(entry.mediaType)) {
    throw new CompilerError("asset.media_type", `Unsupported media type ${String(entry.mediaType)}`);
  }
  if (!Number.isSafeInteger(entry.byteSize) || Number(entry.byteSize) <= 0) {
    throw new CompilerError("asset.byte_size", `Invalid byte size for ${entry.key}`);
  }
}
