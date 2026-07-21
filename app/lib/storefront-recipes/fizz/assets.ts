import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const FIZZ_STATIC_ASSET_KEYS = ["hero"] as const;

export const FIZZ_ASSETS: AssetManifest = { entries: [{ key: "hero", contentHash: "8c988a90a823037c5e6772c7733302878ef43505093a33fc428a2a203e028c9d", mediaType: "image/webp", byteSize: 95500 }] };
