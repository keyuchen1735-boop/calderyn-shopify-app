// app/lib/screener/meta-creative.server.ts
// Reads paused ads + their creative from the connected Meta account and shapes
// them into the screener's CreativeInput. Pure parsers are exported for testing;
// the I/O wrappers build on the existing metaClientForShop. Never throws on
// sparse creatives — missing fields degrade to empty strings / null image so
// scoring can still run copy-only.
import { metaClientForShop, type MetaConnection } from "../meta/client.server";
import type { MetaResponse } from "../meta/campaigns.server";
import type { CreativeInput, ScreenableAd } from "./types";

// ---- pure parsers ----

export function mapAdListItem(raw: Record<string, unknown>): ScreenableAd {
  return {
    id: String(raw.id ?? ""),
    name: typeof raw.name === "string" && raw.name ? raw.name : "(untitled ad)",
    effectiveStatus:
      typeof raw.effective_status === "string"
        ? raw.effective_status
        : typeof raw.status === "string"
          ? (raw.status as string)
          : "UNKNOWN",
  };
}

const GENDER_LABEL: Record<number, string> = { 1: "men", 2: "women" };

export function summarizeTargeting(t: Record<string, unknown> | null | undefined): string {
  if (!t || typeof t !== "object") return "Broad / unspecified audience";
  const parts: string[] = [];

  const geo = (t.geo_locations as { countries?: unknown } | undefined)?.countries;
  if (Array.isArray(geo) && geo.length) parts.push(geo.filter((c) => typeof c === "string").join(", "));

  const min = t.age_min as number | undefined;
  const max = t.age_max as number | undefined;
  if (min || max) parts.push(`${min ?? 18}–${max ?? 65}`);

  const genders = t.genders as number[] | undefined;
  if (Array.isArray(genders) && genders.length) {
    const g = genders.map((n) => GENDER_LABEL[n]).filter(Boolean);
    if (g.length) parts.push(g.join(" & "));
  }

  const flex = t.flexible_spec as Array<{ interests?: Array<{ name?: string }> }> | undefined;
  const interests = Array.isArray(flex)
    ? flex.flatMap((f) => (f.interests ?? []).map((i) => i.name).filter((n): n is string => !!n))
    : [];
  if (interests.length) parts.push(`interested in ${interests.slice(0, 5).join(", ")}`);

  return parts.length ? parts.join(" · ") : "Broad / unspecified audience";
}

type LinkData = {
  message?: string;
  name?: string;
  link?: string;
  call_to_action?: { type?: string; value?: { link?: string } };
};
type AssetFeed = {
  titles?: Array<{ text?: string }>;
  bodies?: Array<{ text?: string }>;
  link_urls?: Array<{ website_url?: string }>;
  call_to_action_types?: string[];
};
type RawCreative = {
  title?: string;
  body?: string;
  image_url?: string;
  link_url?: string;
  call_to_action_type?: string;
  object_story_spec?: { link_data?: LinkData };
  asset_feed_spec?: AssetFeed;
};

const firstStr = (...vals: Array<unknown>): string => {
  for (const v of vals) if (typeof v === "string" && v) return v;
  return "";
};

/** Shape a raw `{creative, adset}` ad object into a CreativeInput. Never throws. */
export function parseCreativeInput(rawAd: Record<string, unknown>): CreativeInput {
  const creative = (rawAd.creative ?? {}) as RawCreative;
  const link = creative.object_story_spec?.link_data;
  const afs = creative.asset_feed_spec;

  const headline = firstStr(link?.name, creative.title, afs?.titles?.[0]?.text);
  const primaryText = firstStr(link?.message, creative.body, afs?.bodies?.[0]?.text);
  const cta = firstStr(
    link?.call_to_action?.type,
    creative.call_to_action_type,
    afs?.call_to_action_types?.[0],
  ) || "SHOP_NOW";
  const destinationUrl = firstStr(
    link?.link,
    link?.call_to_action?.value?.link,
    creative.link_url,
    afs?.link_urls?.[0]?.website_url,
  );
  const imageUrl = firstStr(creative.image_url) || null;

  const targeting = (rawAd.adset as { targeting?: Record<string, unknown> } | undefined)?.targeting;
  const audience = summarizeTargeting(targeting);

  return { imageUrl, headline, primaryText, cta, destinationUrl, audience };
}

// ---- I/O (build on the existing Meta client) ----

function check(r: MetaResponse): MetaResponse {
  if (r.error) throw new Error(`Meta API error: ${r.error.message}`);
  return r;
}

/**
 * Ads in the connected account, for the picker — active AND paused, so the list
 * doesn't silently empty out when a merchant activates their only paused ad
 * (scoring is read-only; the push-variant flow still creates PAUSED ads).
 */
async function readScreenableAds(conn: MetaConnection): Promise<ScreenableAd[]> {
  const body = check(
    await conn.client.get(`/${conn.adAccountId}/ads`, {
      fields: "id,name,effective_status",
      effective_status: JSON.stringify(["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED"]),
      limit: "50",
    }),
  );
  const rows = (body.data as Array<Record<string, unknown>>) ?? [];
  return rows.map(mapAdListItem);
}

export type ScreenableAdSource = {
  connected: boolean;
  ads: ScreenableAd[];
  /** True when Meta is connected but the ads read failed — "no ads" would be a lie. */
  adsError: boolean;
};

/**
 * Picker payload for the screener loader. Distinguishes the three states the UI
 * must word differently: not connected (connect prompt), connected with a failed
 * read (transient-error notice, rule 12), connected with a clean read (list or
 * genuine empty state). Never throws — the page must survive a Meta hiccup.
 */
export async function screenableAdSource(shop: string): Promise<ScreenableAdSource> {
  const conn = await metaClientForShop(shop).catch(() => null);
  if (!conn) return { connected: false, ads: [], adsError: false };
  try {
    return { connected: true, ads: await readScreenableAds(conn), adsError: false };
  } catch {
    return { connected: true, ads: [], adsError: true };
  }
}

/** Fetch one ad's creative + adset targeting and shape it into a CreativeInput. */
export async function fetchCreativeInput(shop: string, adId: string): Promise<CreativeInput> {
  const conn = await metaClientForShop(shop);
  if (!conn) throw new Error("Meta account is not connected");
  const body = check(
    await conn.client.get(`/${adId}`, {
      fields:
        "name,creative{title,body,image_url,link_url,call_to_action_type,object_story_spec,asset_feed_spec},adset{targeting}",
    }),
  );
  return parseCreativeInput(body as Record<string, unknown>);
}
