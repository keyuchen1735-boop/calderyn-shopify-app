import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const HAVEN_VIDEO_ROLES = ["hero", "hero-alt", "pdp-detail"] as const;
export const HAVEN_VIDEO_ASSET_KEYS = HAVEN_VIDEO_ROLES.flatMap((role) => [
  `${role}-poster`, `${role}-webm`, `${role}-mp4`,
]);

// Media stays absent until generation, import, and visual approval all succeed.
export const HAVEN_ASSETS: AssetManifest = { entries: [] };
