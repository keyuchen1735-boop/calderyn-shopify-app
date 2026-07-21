import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const HAVEN_ASSET_KEYS = ["hero"] as const;

export const HAVEN_ASSETS: AssetManifest = { entries: [{ key: "hero", contentHash: "f775d040ec74ea90405b24926bcc716271cc5d6b4beae2b5a748214ac6795c4e", mediaType: "image/webp", byteSize: 123674 }] };
