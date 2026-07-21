import type { AssetManifest } from "../../storefront-bundle/types";

export const GILT_ASSET_KEYS = ["hero"] as const;

export const GILT_ASSETS = { entries: [{ key: "hero", contentHash: "817cb9566e5ca7202f04370d68124e28236f075dd01e65c37ccbebbdab7be076", mediaType: "image/webp", byteSize: 92100 }] } satisfies AssetManifest;
