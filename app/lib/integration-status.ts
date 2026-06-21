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
