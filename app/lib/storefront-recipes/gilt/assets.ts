import type { AssetManifest } from "../../storefront-bundle/types";

export const GILT_VIDEO_ROLES = ["hero", "hero-alt", "pdp-detail"] as const;

// Video generation is blocked until the Unsora account has credits; do not invent immutable asset metadata.
export const GILT_ASSETS = { entries: [] } satisfies AssetManifest;
