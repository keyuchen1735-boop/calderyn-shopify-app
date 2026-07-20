import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const VOLT_VIDEO_ROLES = ["hero", "hero-alt", "pdp-detail"] as const;

export const VOLT_VIDEO_ASSET_KEYS = VOLT_VIDEO_ROLES.flatMap((role) => [
  `${role}-poster`,
  `${role}-webm`,
  `${role}-mp4`,
]);

// Media remains fail-closed until generated derivatives receive technical and visual approval.
export const VOLT_ASSETS: AssetManifest = { entries: [] };
