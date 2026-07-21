// Weekly competitor auto-discovery - the repo's FIRST use of Claude's
// web_search server tool (basic web_search_20250305; the digest-class default
// model does not support the 20260209 variant). One quota-gated call per shop
// per run (max_uses caps searches inside it); suggestions are written with
// status 'suggested' ONLY - a merchant confirmation is the only path to
// 'watching'. Demo/fixture shops never reach the network or the model.
import type Anthropic from "@anthropic-ai/sdk";
import { checkAiQuota } from "~/lib/ai-quota.server";
import { getAnthropic, radarDiscoveryModel } from "~/lib/assistant/anthropic.server";
import { isShowcaseShop } from "~/lib/demo/showcase.server";
import { isUuid } from "~/lib/ids";
import { getSeoSettings } from "~/lib/seo/seo-store.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import { countCompetitors, insertSuggestion, MAX_WATCHED_COMPETITORS } from "./competitor-store.server";
import { isPubliclyRoutableHttps } from "./fetch.server";
import { stampRadarState } from "./store.server";

export const DISCOVERY_MAX_SEARCHES = 3;
export const DISCOVERY_MAX_SUGGESTIONS = 5;
const MAX_PAUSE_RESUMES = 2;
const SEED_PRODUCTS = 5;

/** Marketplaces/socials/reference sites are never competitor suggestions. */
const BLOCKED_HOST_FRAGMENTS = [
  "amazon.", "ebay.", "etsy.", "walmart.", "aliexpress.", "temu.",
  "facebook.", "instagram.", "pinterest.", "youtube.", "reddit.", "wikipedia.",
];

const SYSTEM =
  "You research direct competitors for a small online store. Use web search to find up to " +
  `${DISCOVERY_MAX_SUGGESTIONS} independent ONLINE STORES that sell products similar to the store described. ` +
  "Only real, currently operating store websites. Exclude marketplaces (Amazon, eBay, Etsy, Walmart), " +
  "social networks, blogs, directories, review sites, and the store itself. " +
  'Respond with JSON only: [{"url":"https://...","name":"Store name","reason":"one plain sentence on why it competes"}]';

interface RawSuggestion {
  url?: unknown;
  name?: unknown;
  reason?: unknown;
}

/** Try to JSON.parse a `[start, lastIndexOf("]")]` slice; null on any failure
 *  (bad indices, parse error, or a non-array result). */
function tryParseArraySlice(text: string, start: number, end: number): RawSuggestion[] | null {
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? (parsed as RawSuggestion[]) : null;
  } catch {
    return null;
  }
}

function parseSuggestions(text: string): RawSuggestion[] {
  // Strip Markdown code fences first if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const toparse = fenceMatch ? fenceMatch[1] : text;

  const lastBracket = toparse.lastIndexOf("]");
  // Try the first "[" first: this is the correct slice whenever the JSON
  // array itself is the only bracketed content (e.g. a suggestion's `reason`
  // field legitimately contains a "["). Fall back to the last "[" - the
  // previous behavior - which is what correctly skips past leading markdown
  // link brackets like "[text](url)" that precede the real array.
  return (
    tryParseArraySlice(toparse, toparse.indexOf("["), lastBracket) ??
    tryParseArraySlice(toparse, toparse.lastIndexOf("["), lastBracket) ??
    []
  );
}

function normalizeOrigin(raw: unknown, ownHost: string | null): { url: string; host: string } | null {
  if (typeof raw !== "string") return null;
  if (!isPubliclyRoutableHttps(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.host.toLowerCase();
  if (ownHost && host === ownHost) return null;
  if (BLOCKED_HOST_FRAGMENTS.some((frag) => host.includes(frag))) return null;
  return { url: `${u.protocol}//${u.host}/`, host };
}

/** Echo a model turn's response content back in as the next request's assistant
 *  turn (the documented pattern for resuming a paused server-tool loop).
 *  ContentBlock and ContentBlockParam are distinct union types; the API ignores
 *  extra response-side fields, so this is a deliberate, narrow `unknown` bridge
 *  rather than a widened `any`. */
function toAssistantTurn(content: Anthropic.ContentBlock[]): Anthropic.ContentBlockParam[] {
  return content as unknown as Anthropic.ContentBlockParam[];
}

export async function discoverShopCompetitors(
  shopId: string,
): Promise<{ suggested: number } | { skipped: string }> {
  if (!isUuid(shopId)) return { skipped: "fixture_shop" };
  if (await isShowcaseShop(shopId)) return { skipped: "demo_shop" };
  const [suggestedCount, watchingCount] = await Promise.all([
    countCompetitors(shopId, "suggested"),
    countCompetitors(shopId, "watching"),
  ]);
  // These two skips are routine and can recur night after night for the same
  // shop (a merchant who never confirms suggestions, or who has watched the
  // max already) - stamping the cursor here keeps such a shop from wedging
  // the front of the nulls-first discovery queue forever.
  if (suggestedCount >= DISCOVERY_MAX_SUGGESTIONS) {
    await stampRadarState(shopId, { lastDiscoveredAt: new Date().toISOString() });
    return { skipped: "suggestion_backlog" };
  }
  if (watchingCount >= MAX_WATCHED_COMPETITORS) {
    await stampRadarState(shopId, { lastDiscoveredAt: new Date().toISOString() });
    return { skipped: "watch_list_full" };
  }

  const [store, seo, products, origin] = await Promise.all([
    getStoreSettings(shopId),
    getSeoSettings(shopId),
    getCatalog().listProducts(shopId, { limit: SEED_PRODUCTS }),
    getShopStorefrontOrigin(shopId),
  ]);
  const ownHost = origin ? new URL(origin).host.toLowerCase() : null;
  const seeds = {
    storeName: store.storeName,
    description: seo.orgDescription ?? store.voiceTagline ?? "",
    topProducts: products.slice(0, SEED_PRODUCTS).map((p) => p.title),
    ownDomain: ownHost ?? "",
  };

  const tools: Anthropic.ToolUnion[] = [
    { type: "web_search_20250305", name: "web_search", max_uses: DISCOVERY_MAX_SEARCHES },
  ];
  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Find competitors for this store:\n${JSON.stringify(seeds)}` },
  ];

  // Check quota once upfront before the loop; pause_turn continuations proceed
  // without further quota checks (the loop is bounded by MAX_PAUSE_RESUMES).
  const verdict = await checkAiQuota({ shopId, feature: "radar_discovery", trusted: true });
  // A quota denial is just as capable of wedging the queue head as the two
  // backlog checks above (a shop stuck over its daily/plan cap would
  // otherwise sort first every night), so it stamps the cursor too.
  if (!verdict.allowed) {
    await stampRadarState(shopId, { lastDiscoveredAt: new Date().toISOString() });
    return { skipped: verdict.code };
  }

  let res: Anthropic.Message | null = null;
  for (let attempt = 0; attempt <= MAX_PAUSE_RESUMES; attempt++) {
    res = await getAnthropic().messages.create({
      model: radarDiscoveryModel(),
      max_tokens: 1500,
      system: SYSTEM,
      messages,
      tools,
    });
    if (res.stop_reason !== "pause_turn") break;
    // Server-tool loop paused: append the assistant turn as-is and continue.
    messages = [...messages, { role: "assistant", content: toAssistantTurn(res.content) }];
  }
  if (!res) return { skipped: "no_response" };

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const raw = parseSuggestions(text);
  if (raw.length === 0) {
    console.error(`[radar] discovery returned no parseable suggestions for shop ${shopId}`, { text: text.slice(0, 500) });
  }

  const seenHosts = new Set<string>();
  let suggested = 0;
  for (const s of raw) {
    if (suggested >= DISCOVERY_MAX_SUGGESTIONS) break;
    const normalized = normalizeOrigin(s.url, ownHost);
    if (!normalized || seenHosts.has(normalized.host)) continue;
    seenHosts.add(normalized.host);
    const outcome = await insertSuggestion(shopId, {
      url: normalized.url,
      name: typeof s.name === "string" ? s.name.slice(0, 120) : normalized.host,
      // Only `reason` is ever read back (dashboard.api.radar.tsx's competitor
      // VM projects discoveryEvidence.reason and nothing else) - the seed
      // payload (store description + top products) is the same object for
      // every suggestion in a run, so persisting it per-row was pure storage
      // waste with no reader.
      evidence: {
        reason: typeof s.reason === "string" ? s.reason.slice(0, 300) : "",
        discoveredAt: new Date().toISOString(),
      },
    });
    if (outcome === "inserted") suggested++;
  }
  await stampRadarState(shopId, { lastDiscoveredAt: new Date().toISOString() });
  return { suggested };
}
