import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const EMBER_VIDEO_ROLES = ["hero", "hero-alt", "pdp-detail"] as const;

export const EMBER_VIDEO_ASSET_KEYS = EMBER_VIDEO_ROLES.flatMap((role) => [
  `${role}-poster`,
  `${role}-webm`,
  `${role}-mp4`,
]);

// Video references stay unresolved until all masters and derivatives pass review.
export const EMBER_ASSETS: AssetManifest = { entries: [] };
