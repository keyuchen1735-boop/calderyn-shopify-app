// app/lib/assets/upload.server.ts
//
// Merchant image uploads into the owned PUBLIC bucket (#9). Validation is
// bytes-first: the size cap and the content-type allowlist are enforced against
// the ACTUAL bytes (magic-number sniff) — the browser-declared type is never
// trusted, so a renamed script or an SVG (script-carrying) cannot slip through.
// A public bucket must never hold PII: only the four raster image types below
// are accepted, all stored with source 'upload'.
import { CalderynError } from "~/lib/calderyn.server";
import {
  MAX_IMAGE_BYTES,
  sniffImageMime,
  storeImageBytes,
  type StoredAsset,
} from "./persist.server";

export const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES; // ~10 MB
// Raster only. SVG is intentionally excluded (can carry script -> stored XSS on
// a public origin). Matches the bug-report / product-media allowlists.
export const ALLOWED_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/**
 * Validate and persist a merchant-uploaded image. Throws a CalderynError with a
 * 4xx status on a rejected upload (so the dashboard envelope maps it), returns
 * the owned public URL + asset id on success.
 */
export async function persistUploadedImage(
  shopId: string,
  file: { bytes: Uint8Array; declaredType?: string },
): Promise<StoredAsset & { mime: string }> {
  if (file.bytes.byteLength === 0) {
    throw new CalderynError({ code: "empty_file", status: 422, message: "That file is empty." });
  }
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new CalderynError({ code: "file_too_large", status: 413, message: "Images must be 10 MB or smaller." });
  }
  // Trust the bytes, not the header: sniff the real content type.
  const mime = sniffImageMime(file.bytes);
  if (!mime || !(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(mime)) {
    throw new CalderynError({
      code: "unsupported_type",
      status: 415,
      message: "Only PNG, JPG, GIF, or WebP images are allowed.",
    });
  }
  const stored = await storeImageBytes(shopId, file.bytes, { kind: "upload", source: "upload", mime });
  return { ...stored, mime };
}
