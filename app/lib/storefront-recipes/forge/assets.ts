import type { AssetManifest } from "~/lib/storefront-bundle/types";

export const FORGE_VIDEO_ROLES = ["hero", "hero-alt", "pdp-detail"] as const;

// Media remains fail-closed until generated derivatives receive technical and visual approval.
export const FORGE_ASSETS: AssetManifest = { entries: [] };
