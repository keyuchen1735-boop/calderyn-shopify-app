// Fetch a Google Ads campaign's ads + creatives and normalize them into the same
// platform-agnostic CampaignCreative / CreativeInput shape Meta produces, so the
// campaign-detail UI and the predictive score route stay platform-blind.
//
// parseGoogleAdCreative is PURE and defensive — it never throws on sparse/missing
// data (rule 12: surface gaps as empty defaults rather than crashing the detail
// page). It reads the searchStream result rows in snake_case, matching the rest
// of the Google module (transform.ts reads `c.campaign?.id`,
// `r.metrics?.cost_micros`, …) — rule 11, match the existing convention.

import type { GoogleAdsClient } from "./client.server";
import type { CampaignCreative } from "~/lib/meta/creatives.server";
import type { CreativeInput } from "~/lib/screener/types";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce to a string, else "". */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** First element of an array, or undefined. */
function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : undefined;
}

/** Read `.text` off the first element of an array of `{ text }` blobs, else "". */
function firstText(arr: unknown): string {
  const head = first(arr);
  return isObject(head) ? str(head.text) : "";
}

const EMPTY_CREATIVE: CreativeInput = {
  imageUrl: null,
  headline: "",
  primaryText: "",
  cta: "",
  destinationUrl: "",
  audience: "",
};

/**
 * Read the headline + primaryText from whichever ad subtype is present, in
 * priority order, picking the first subtype that yields a non-empty headline
 * (mirrors meta's parseCreative priority approach):
 *  1) responsive_search_ad: headlines[0].text / descriptions[0].text
 *  2) responsive_display_ad: headlines[0].text / descriptions[0].text
 *  3) legacy expanded_text_ad: headline_part1 / description
 * None present → { headline: "", primaryText: "" }.
 */
function parseHeadlineAndText(ad: Record<string, unknown>): {
  headline: string;
  primaryText: string;
} {
  const rsa = ad.responsive_search_ad;
  if (isObject(rsa)) {
    const headline = firstText(rsa.headlines);
    if (headline) return { headline, primaryText: firstText(rsa.descriptions) };
  }

  const rda = ad.responsive_display_ad;
  if (isObject(rda)) {
    const headline = firstText(rda.headlines);
    if (headline) return { headline, primaryText: firstText(rda.descriptions) };
  }

  const eta = ad.expanded_text_ad;
  if (isObject(eta)) {
    const headline = str(eta.headline_part1);
    if (headline) return { headline, primaryText: str(eta.description) };
  }

  return { headline: "", primaryText: "" };
}

// PURE — never throws on sparse/missing data; missing fields degrade to "" / null.
// A row is shaped `{ ad_group_ad: { ad: {...}, status }, … }`.
export function parseGoogleAdCreative(row: unknown): CampaignCreative {
  const groupAd = isObject(row) ? row.ad_group_ad : undefined;
  if (!isObject(groupAd)) {
    return { adId: "", adName: "", status: "UNKNOWN", creative: { ...EMPTY_CREATIVE } };
  }
  const ad = isObject(groupAd.ad) ? groupAd.ad : {};
  const { headline, primaryText } = parseHeadlineAndText(ad);

  return {
    adId: str(ad.id),
    adName: str(ad.name),
    status: str(groupAd.status) || "UNKNOWN",
    creative: {
      // imageUrl is left null: Google image assets are referenced by asset
      // resource name (e.g. "customers/123/assets/456"), not a direct URL, so
      // resolving them needs a separate asset lookup — OUT OF SCOPE here. The UI
      // shows the image placeholder. (Mirrors meta's image-hash limitation.)
      imageUrl: null,
      headline,
      primaryText,
      // Google RSA/RDA have no single CTA field — leave empty, do not fabricate.
      cta: "",
      destinationUrl: str(first(ad.final_urls)),
      audience: "",
    },
  };
}

// I/O — run a GAQL query for one campaign's ads, map each row via
// parseGoogleAdCreative. client.search already throws on API errors (rule 12);
// let it propagate so the route's isolated try/catch surfaces it honestly.
export async function listGoogleCampaignCreatives(
  client: GoogleAdsClient,
  campaignId: string,
): Promise<CampaignCreative[]> {
  // Injection safety: campaignId must be a Google numeric id. NEVER interpolate
  // untrusted text into GAQL.
  if (!/^\d+$/.test(campaignId)) {
    throw new Error("Invalid Google campaign id");
  }

  const gaql = `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status,
       ad_group_ad.ad.final_urls,
       ad_group_ad.ad.responsive_search_ad.headlines,
       ad_group_ad.ad.responsive_search_ad.descriptions,
       ad_group_ad.ad.responsive_display_ad.headlines,
       ad_group_ad.ad.responsive_display_ad.descriptions,
       ad_group_ad.ad.expanded_text_ad.headline_part1,
       ad_group_ad.ad.expanded_text_ad.description
FROM ad_group_ad WHERE campaign.id = ${campaignId}`;

  const rows = await client.search(gaql);
  return rows.map(parseGoogleAdCreative);
}
