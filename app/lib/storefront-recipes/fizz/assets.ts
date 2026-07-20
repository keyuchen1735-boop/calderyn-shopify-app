import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const FIZZ_VIDEO_ROLES = ["hero", "hero-alt", "pdp-detail"] as const;
export const FIZZ_VIDEO_ASSET_KEYS = FIZZ_VIDEO_ROLES.flatMap((role) => [
  `${role}-poster`, `${role}-webm`, `${role}-mp4`,
]);

// Media remains absent until generation and visual approval both succeed.
export const FIZZ_ASSETS: AssetManifest = { entries: [] };
