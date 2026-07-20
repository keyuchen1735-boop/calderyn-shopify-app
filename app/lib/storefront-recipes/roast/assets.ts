import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const ROAST_VIDEO_ROLES = ["hero", "brew-context", "bean-grind"] as const;

export const ROAST_VIDEO_ASSET_KEYS = ROAST_VIDEO_ROLES.flatMap((role) => [
  `${role}-poster`,
  `${role}-webm`,
  `${role}-mp4`,
]);

// Video references stay unresolved until every master and derivative passes review.
export const ROAST_ASSETS: AssetManifest = { entries: [] };
