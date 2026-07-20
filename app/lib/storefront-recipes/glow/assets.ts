import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const GLOW_VIDEO_ROLES = ["hero", "hero-alt", "pdp-detail"] as const;

export const GLOW_VIDEO_ASSET_KEYS = GLOW_VIDEO_ROLES.flatMap((role) => [
  `${role}-poster`,
  `${role}-webm`,
  `${role}-mp4`,
]);

// Media remains fail-closed until generated derivatives receive technical and visual approval.
export const GLOW_ASSETS: AssetManifest = { entries: [] };
