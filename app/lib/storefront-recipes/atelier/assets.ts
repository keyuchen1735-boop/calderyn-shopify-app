import type { AssetManifest } from "../../storefront-bundle/types";

export const ATELIER_ASSET_KEYS = ["hero"] as const;

export const ATELIER_ASSETS = {
  entries: [{ key: "hero", contentHash: "e9a1b1ca7c49b0fb735f4908e0b28afca06d39428fe2754d2427098fb2a15b42", mediaType: "image/webp", byteSize: 65834 }],
} satisfies AssetManifest;
