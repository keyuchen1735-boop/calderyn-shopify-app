// Pure order→campaign matcher. Precedence (best evidence first):
//   1. utm_campaign resolves to a known campaign  -> campaign-level (utm_exact)
//   2. a click-id is present                      -> platform-level (click_id)
//   3. referring_site host maps to a platform     -> platform-level (referrer_host)
//   4. nothing                                     -> unknown
// Confidence: utm match corroborated by a click-id = high; utm match alone =
// strong; platform-only (click-id / referrer) = rough; nothing = none.

import type {
  AttributionSignals,
  AttributionResult,
  CampaignRef,
  ClickIdKind,
  Platform,
} from "./types";
import { clickIdPlatform } from "./parse";

const CLICK_KEYS: ClickIdKind[] = ["fbclid", "gclid", "ttclid"];

const REFERRER_HOST_PLATFORM: Array<{ needle: string; platform: Platform }> = [
  { needle: "facebook.", platform: "meta" },
  { needle: "instagram.", platform: "meta" },
  { needle: "google.", platform: "google" },
  { needle: "googleadservices.", platform: "google" },
  { needle: "tiktok.", platform: "tiktok" },
];

function firstClickId(signals: AttributionSignals): { kind: ClickIdKind; platform: Platform } | null {
  for (const key of CLICK_KEYS) {
    if (signals.clickIds[key]) return { kind: key, platform: clickIdPlatform(key) };
  }
  return null;
}

function matchCampaign(utmCampaign: string, campaigns: CampaignRef[]): CampaignRef | null {
  const needle = utmCampaign.trim().toLowerCase();
  if (!needle) return null;
  // external_id exact, then case-insensitive name.
  return (
    campaigns.find((c) => c.external_id.toLowerCase() === needle) ??
    campaigns.find((c) => c.name.trim().toLowerCase() === needle) ??
    null
  );
}

function referrerPlatform(referringSite: string | null): Platform | null {
  if (!referringSite) return null;
  let host: string;
  try {
    host = new URL(referringSite).hostname.toLowerCase();
  } catch {
    return null;
  }
  return REFERRER_HOST_PLATFORM.find((m) => host.includes(m.needle))?.platform ?? null;
}

export function resolveAttribution(
  signals: AttributionSignals,
  campaigns: CampaignRef[],
): AttributionResult {
  const click = firstClickId(signals);

  // 1. UTM campaign → campaign-level
  const utmCampaign = signals.utm.utm_campaign;
  if (utmCampaign) {
    const campaign = matchCampaign(utmCampaign, campaigns);
    if (campaign) {
      return {
        campaignId: campaign.id,
        platform: campaign.platform,
        method: "utm_exact",
        confidence: click ? "high" : "strong",
      };
    }
  }

  // 2. Click-id → platform-level
  if (click) {
    return { campaignId: null, platform: click.platform, method: "click_id", confidence: "rough" };
  }

  // 3. Referrer host → platform-level
  const refPlatform = referrerPlatform(signals.referringSite);
  if (refPlatform) {
    return { campaignId: null, platform: refPlatform, method: "referrer_host", confidence: "rough" };
  }

  // 4. Nothing
  return { campaignId: null, platform: null, method: "unknown", confidence: "none" };
}
