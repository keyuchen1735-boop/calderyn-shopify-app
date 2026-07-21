import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const FORGE_ASSET_KEYS = ["hero"] as const;

export const FORGE_ASSETS: AssetManifest = { entries: [{ key: "hero", contentHash: "45d0e15cf882b70f4b8f59b1133474f6eb8960b6898b46101173752b9fdea718", mediaType: "image/webp", byteSize: 87496 }] };
