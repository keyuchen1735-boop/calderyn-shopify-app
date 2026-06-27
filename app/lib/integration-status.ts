// Map a campaign's platform to its integration key and tell whether that source
// is disconnected — so the UI can badge campaign data whose source the merchant
// sees as disconnected (e.g. Google Ads with an unapproved dev token) as stale,
// instead of presenting it as live (P2-16). Pure; safe on both surfaces.
//
// Reuses isPaired so a freshly-paired "pending" source is NOT mistaken for
// disconnected (see app/lib/integrations.ts).

import { isPaired } from "./integrations";

export const PLATFORM_INTEGRATION_KEY: Record<string, string> = {
  Meta: "meta_ads",
  Google: "google_ads",
  TikTok: "tiktok_ads",
};

export function isSourceDisconnected(
  platform: string,
  integrations: ReadonlyArray<{ key: string; status: string }>,
): boolean {
  const key = PLATFORM_INTEGRATION_KEY[platform];
  if (!key) return false;
  const it = integrations.find((i) => i.key === key);
  // Only badge a source that exists and is not paired; an absent integration is
  // left unbadged (don't false-flag a platform the merchant never connected).
  // status is normalized to isPaired's union at the data layer (integrations.list).
  return it ? !isPaired(it.status as Parameters<typeof isPaired>[0]) : false;
}

/** True when a stored, comma-joined OAuth scope string carries ads_management
 *  (required to create ad creatives/ads). Pure; safe on both surfaces. */
export function hasAdsManagementScope(scopes: string | null | undefined): boolean {
  if (!scopes) return false;
  return scopes.split(",").map((s) => s.trim()).includes("ads_management");
}

/** Reduce a Graph GET /me/permissions payload to a comma-joined list of the
 *  GRANTED permissions. Defensive: a malformed payload yields "". */
export function grantedScopesFromPermissions(perms: unknown): string {
  const data = (perms as { data?: Array<{ permission?: unknown; status?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) return "";
  return data
    .filter((p) => p?.status === "granted" && typeof p?.permission === "string")
    .map((p) => String(p.permission))
    .join(",");
}
