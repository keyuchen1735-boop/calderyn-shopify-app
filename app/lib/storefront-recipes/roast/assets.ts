import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const ROAST_STATIC_ASSET_KEYS = ["hero"] as const;

export const ROAST_ASSETS: AssetManifest = { entries: [{ key: "hero", contentHash: "07efad6a3cb6c3821919f3e2f0256f94625f7ce9715a0ee10d81c5372f610c6a", mediaType: "image/webp", byteSize: 64322 }] };
