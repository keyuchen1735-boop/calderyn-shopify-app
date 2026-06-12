// Fetch a Meta campaign's ads + creatives and normalize them into CreativeInput.
// parseAdCreative is PURE and defensive — it never throws on sparse/missing data
// (rule 12: surface gaps as empty defaults rather than crashing the detail page).

import { check, type MetaClient, type MetaResponse } from "./campaigns.server";
import type { CreativeInput } from "~/lib/screener/types";

export interface CampaignCreative {
  adId: string;
  adName: string;
  status: string; // raw Meta status, e.g. "ACTIVE" | "PAUSED"
  creative: CreativeInput; // normalized creative content
}

export const CREATIVE_FIELDS =
  "id,name,status,creative{object_story_spec,asset_feed_spec,title,body,image_url,object_url,call_to_action_type,link_url}";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Coerce to a non-empty string, else "". */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Coerce to a URL string, else null. */
function urlOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** First element of an array, or undefined. */
function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : undefined;
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
 * Reads the creative blob in priority order:
 * 1) object_story_spec.link_data, 2) asset_feed_spec, 3) legacy top-level fields.
 * Targeting/audience is out of scope here, so audience is always "".
 */
function parseCreative(creative: unknown): CreativeInput {
  if (!isObject(creative)) return { ...EMPTY_CREATIVE };

  // 1) object_story_spec.link_data (most common).
  const oss = creative.object_story_spec;
  if (isObject(oss) && isObject(oss.link_data)) {
    const ld = oss.link_data;
    const cta = isObject(ld.call_to_action) ? str(ld.call_to_action.type) : "";
    return {
      imageUrl: urlOrNull(ld.picture),
      headline: str(ld.name),
      primaryText: str(ld.message),
      cta,
      destinationUrl: str(ld.link),
      audience: "",
    };
  }

  // 2) asset_feed_spec (Advantage+ — arrays; take the first element of each).
  // Checked before legacy because legacy top-level fields are absent on
  // Advantage+ creatives, and asset_feed_spec is the richer source.
  const afs = creative.asset_feed_spec;
  if (isObject(afs)) {
    const title = first(afs.titles);
    const body = first(afs.bodies);
    const link = first(afs.link_urls);
    const image = first(afs.images);
    return {
      imageUrl: isObject(image) ? urlOrNull(image.url) : null,
      headline: isObject(title) ? str(title.text) : "",
      primaryText: isObject(body) ? str(body.text) : "",
      cta: str(first(afs.call_to_action_types)),
      destinationUrl: isObject(link) ? str(link.website_url) : "",
      audience: "",
    };
  }

  // 3) Legacy top-level creative fields.
  return {
    imageUrl: urlOrNull(creative.image_url),
    headline: str(creative.title),
    primaryText: str(creative.body),
    cta: str(creative.call_to_action_type),
    destinationUrl: str(creative.object_url) || str(creative.link_url),
    audience: "",
  };
}

// PURE — never throws on sparse/missing data; missing fields degrade to "" / null.
export function parseAdCreative(rawAd: unknown): CampaignCreative {
  if (!isObject(rawAd)) {
    return { adId: "", adName: "", status: "UNKNOWN", creative: { ...EMPTY_CREATIVE } };
  }
  return {
    adId: str(rawAd.id),
    adName: str(rawAd.name),
    status: str(rawAd.status) || "UNKNOWN",
    creative: parseCreative(rawAd.creative),
  };
}

// I/O — GET /{campaignId}/ads with the creative fields, map each via parseAdCreative.
// Paging is not handled (single page); a campaign with >25 ads would be truncated.
export async function listCampaignCreatives(
  client: MetaClient,
  campaignId: string,
): Promise<CampaignCreative[]> {
  // Injection safety: campaignId must be a Meta numeric id. NEVER interpolate
  // untrusted text into the request path.
  if (!/^\d+$/.test(campaignId)) {
    throw new Error("Invalid Meta campaign id");
  }

  const body: MetaResponse = await client.get(`/${campaignId}/ads`, { fields: CREATIVE_FIELDS });
  check(body);
  const data = (body.data as unknown[]) ?? [];
  return data.map(parseAdCreative);
}
