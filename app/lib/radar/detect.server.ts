// Deterministic Radar detectors: pure functions over collected rows. No DB, no
// Claude, no clock reads except via parameters - every threshold is a named
// exported constant so tests and tuning share one source of truth.
//
// Input contract: `series` arrives already bounded to the LAST 14 CALENDAR
// DAYS by the read_radar_ranking_series RPC (per page,query). Detectors below
// additionally enforce their own, narrower windows within that 14-day input
// (e.g. a 3-day sustain check, a 7-day CTR window) - never assume the RPC's
// 14-day bound alone is tight enough for a given detector's claim.
import type { AiCrawlDay, JsonLdCheckedPage, RadarCandidate, RadarCollectInputs, RankingSeries, TrafficDay } from "./types";

// ── Rankings thresholds (spec defaults) ──────────────────────────────────────
export const RANK_SLIP_POSITIONS = 3;
export const RANK_SLIP_SUSTAIN_DAYS = 3;
export const CTR_MIN_IMPRESSIONS = 100;
export const CTR_LOW_FACTOR = 0.5;
/** Rough expected CTR by Google position 1..10 (industry-typical curve). */
export const EXPECTED_CTR_BY_POSITION = [
  0.28, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02,
] as const;
export const RISING_POS_MIN = 8;
export const RISING_POS_MAX = 20;
export const RISING_GROWTH_FACTOR = 1.5;
export const RISING_MIN_RECENT_IMPRESSIONS = 30;

export interface StorefrontEntityRef {
  entityType: "home" | "product" | "collection" | "other";
  handle: string | null;
}

/** Map a ranking page_url or storefront_event path onto the owned-storefront
 *  entity it serves. Tolerates full URLs and bare paths. */
export function parseStorefrontPath(pageUrl: string): StorefrontEntityRef {
  let path = pageUrl;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    // already a bare path
  }
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  const at = parts.indexOf("storefront");
  const rest = at >= 0 ? parts.slice(at + 1) : parts;
  if (rest.length === 0) return { entityType: "home", handle: null };
  if (rest[0] === "products" && rest[1]) return { entityType: "product", handle: rest[1] };
  if (rest[0] === "collections" && rest[1]) return { entityType: "collection", handle: rest[1] };
  return { entityType: "other", handle: null };
}

function pageLabel(ref: StorefrontEntityRef): string {
  if (ref.entityType === "home") return "Your home page";
  if (ref.entityType === "product" && ref.handle) return `Your "${ref.handle.replace(/-/g, " ")}" page`;
  if (ref.entityType === "collection" && ref.handle) return `Your "${ref.handle.replace(/-/g, " ")}" collection`;
  return "One of your pages";
}

function sortedDays<T extends { day: string }>(days: T[]): T[] {
  return [...days].sort((a, b) => a.day.localeCompare(b.day));
}

/** Whole calendar days between two YYYY-MM-DD strings (b - a). */
function daySpan(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(b) - Date.parse(a)) / msPerDay);
}

/** Shift a YYYY-MM-DD string by `delta` calendar days (negative = earlier). */
function addDays(day: string, delta: number): string {
  const d = new Date(Date.parse(day));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** SEO publishes only work for product pages today (the storefront serve path
 *  reads product overrides only) - everything else becomes a review move. */
function seoPayload(
  ref: StorefrontEntityRef,
  pageUrl: string,
  focusQuery: string,
): RadarCandidate["payload"] {
  if (ref.entityType === "product" && ref.handle) {
    return { applyMode: "publish_meta", entityType: "product", handle: ref.handle, focusQuery, pageUrl };
  }
  return { applyMode: "review", pageUrl, focusQuery, deepLink: "/dashboard/store/preferences" };
}

export function detectRankingSlips(series: RankingSeries[]): RadarCandidate[] {
  const out: RadarCandidate[] = [];
  for (const s of series) {
    const days = sortedDays(s.days);
    // Need the 3 sustained "recent" points plus at least 2 "earlier" points
    // to form a meaningful baseline average (a baseline of 1 point is just
    // another single-day reading, not a trend).
    if (days.length < RANK_SLIP_SUSTAIN_DAYS + 2) continue;
    const recent = days.slice(-RANK_SLIP_SUSTAIN_DAYS);
    const earlier = days.slice(0, -RANK_SLIP_SUSTAIN_DAYS);
    // The 3 "recent" points must actually be recent and contiguous-ish - a
    // gap inside them (a data hole spanning more than 4 calendar days) must
    // not be allowed to fake a sustained slip.
    if (daySpan(recent[0].day, recent[recent.length - 1].day) > 4) continue;
    // Average, not all-time-best: a single fluke great day in `earlier`
    // must not poison the baseline every later comparison gets measured
    // against.
    const baseline = earlier.reduce((n, d) => n + d.position, 0) / earlier.length;
    if (!recent.every((d) => d.position >= baseline + RANK_SLIP_POSITIONS)) continue;
    const nowPos = recent[recent.length - 1].position;
    const ref = parseStorefrontPath(s.pageUrl);
    const baselineDisplay = Math.round(baseline * 10) / 10;
    out.push({
      kind: "seo_regression_patch",
      dedupKey: `rank-slip:${s.pageUrl}:${s.query}`,
      headline: `Win back "${s.query}" on Google`,
      rationale:
        `${pageLabel(ref)} was around #${baselineDisplay} on Google for "${s.query}" ` +
        `and has sat at #${Math.round(nowPos)} or lower for ${RANK_SLIP_SUSTAIN_DAYS} days.`,
      evidence: {
        chips: [`was #${baselineDisplay}`, `now #${Math.round(nowPos)}`, `${RANK_SLIP_SUSTAIN_DAYS} days running`],
        facts: { pageUrl: s.pageUrl, query: s.query, baseline, nowPos },
      },
      payload: seoPayload(ref, s.pageUrl, s.query),
    });
  }
  return out;
}

export function detectCtrLow(series: RankingSeries[]): RadarCandidate[] {
  const out: RadarCandidate[] = [];
  for (const s of series) {
    const sorted = sortedDays(s.days);
    if (sorted.length === 0) continue;
    // Restrict to the last 7 calendar days present in the series so the
    // "spot #N" evidence reflects current standing, not a stale average
    // blended with data up to a week older.
    const cutoff = addDays(sorted[sorted.length - 1].day, -6);
    const window = sorted.filter((d) => d.day >= cutoff);
    const impressions = window.reduce((n, d) => n + d.impressions, 0);
    if (impressions < CTR_MIN_IMPRESSIONS) continue;
    const clicks = window.reduce((n, d) => n + d.clicks, 0);
    const avgPos = window.reduce((n, d) => n + d.position * d.impressions, 0) / impressions;
    if (avgPos > 10) continue;
    const slot = Math.min(Math.max(Math.round(avgPos), 1), 10);
    const expected = EXPECTED_CTR_BY_POSITION[slot - 1];
    const ctr = clicks / impressions;
    if (ctr >= expected * CTR_LOW_FACTOR) continue;
    const ref = parseStorefrontPath(s.pageUrl);
    out.push({
      kind: "seo_meta_rewrite",
      dedupKey: `ctr-low:${s.pageUrl}:${s.query}`,
      headline: `Make "${s.query}" worth the click`,
      rationale:
        `${pageLabel(ref)} shows up around #${slot} on Google for "${s.query}" but only ` +
        `${(ctr * 100).toFixed(1)}% of people click it - about half what that spot usually gets. ` +
        `A clearer title and description can close that gap.`,
      evidence: {
        chips: [`spot #${slot}`, `${(ctr * 100).toFixed(1)}% clicks`, `${impressions} views on Google`],
        facts: { pageUrl: s.pageUrl, query: s.query, avgPos, ctr, expectedCtr: expected, impressions },
      },
      payload: seoPayload(ref, s.pageUrl, s.query),
    });
  }
  return out;
}

export function detectRisingQueries(series: RankingSeries[]): RadarCandidate[] {
  // dedupKey is query-level ("rising:<query>") on purpose, but a query can rank
  // on several pages. Keep at most one candidate per query (the page with the
  // most recent-week impressions wins) so a single drain batch never emits two
  // drafts colliding on the radar_ploy (shop, kind, dedup_key) unique index.
  const best = new Map<string, { lastImp: number; candidate: RadarCandidate }>();
  for (const s of series) {
    const days = sortedDays(s.days);
    const last = days.slice(-7);
    const prior = days.slice(-14, -7);
    const lastImp = last.reduce((n, d) => n + d.impressions, 0);
    const priorImp = prior.reduce((n, d) => n + d.impressions, 0);
    if (lastImp < RISING_MIN_RECENT_IMPRESSIONS) continue;
    if (priorImp > 0 && lastImp < priorImp * RISING_GROWTH_FACTOR) continue;
    const avgPos = last.reduce((n, d) => n + d.position * d.impressions, 0) / lastImp;
    if (avgPos < RISING_POS_MIN || avgPos > RISING_POS_MAX) continue;
    const ref = parseStorefrontPath(s.pageUrl);
    const candidate: RadarCandidate = {
      kind: "seo_content_boost",
      // Dedup is query-level (not page+query) on purpose: a rising query is
      // one move to make even if it ranks on two different pages.
      dedupKey: `rising:${s.query}`,
      headline: `"${s.query}" is picking up - lean in`,
      rationale:
        `More people are searching "${s.query}" and finding you around #${Math.round(avgPos)} on Google. ` +
        `Speaking to that search directly in the page title and description can push it onto page one.`,
      evidence: {
        chips: [`#${Math.round(avgPos)} and rising`, `${lastImp} views this week`, `${priorImp} last week`],
        facts: { pageUrl: s.pageUrl, query: s.query, avgPos, lastImp, priorImp },
      },
      payload: seoPayload(ref, s.pageUrl, s.query),
    };
    const prev = best.get(s.query);
    if (!prev || lastImp > prev.lastImp) best.set(s.query, { lastImp, candidate });
  }
  return [...best.values()].map((b) => b.candidate);
}

// ── Traffic + AEO thresholds (spec defaults) ─────────────────────────────────
export const TRAFFIC_DROP_PCT = 0.3;
export const TRAFFIC_TOP_PAGES = 10;
/** A page whose 7-day average is below this many daily views is too thin to
 *  call a "drop" without drafting noise. */
export const TRAFFIC_MIN_BASELINE_VIEWS = 30;
export const CONV_GAP_MIN_VIEWS = 50;
export const CONV_GAP_MAX_CART_RATE = 0.01;
export const STALE_SECTION_WEEKS = 6;
/** "Declining" = the last 7 days at or below 85% of the prior 7 days. */
export const STALE_DECLINE_RATIO = 0.85;
export const AEO_QUIET_DAYS = 7;
export const AEO_MIN_PRIOR_HITS = 5;

const DAY_MS = 86_400_000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Apply-time generation brief: this exact text is the prompt the storefront
 *  edit pipeline receives when the merchant clicks Apply. Keep it product-
 *  neutral and structure-preserving. */
function sectionBrief(target: "home" | "pdp", context: string): string {
  const where = target === "home" ? "the home page's hero section" : "this product page's top section";
  return (
    `Refresh ${where}: rewrite the headline and supporting copy so the page feels current and persuasive. ` +
    `${context} Keep the products, prices, layout structure and navigation unchanged.`
  );
}

export function detectTrafficDrops(days: TrafficDay[]): RadarCandidate[] {
  const sorted = sortedDays(days);
  if (sorted.length < 8) return [];
  const last = sorted[sorted.length - 1];
  const baseline = sorted.slice(-8, -1);
  const totals = new Map<string, number>();
  for (const d of baseline) {
    for (const p of d.topPaths) totals.set(p.path, (totals.get(p.path) ?? 0) + p.views);
  }
  // Filter to refreshable (home/product) paths above the baseline floor BEFORE
  // taking the top slice: ranking first would let high-traffic cart/search/
  // collection pages consume every slot and starve a real home/PDP drop sitting
  // just past rank 10.
  const top = [...totals.entries()]
    .filter(([path, total]) => {
      const entityType = parseStorefrontPath(path).entityType;
      return (entityType === "home" || entityType === "product")
        && total / baseline.length >= TRAFFIC_MIN_BASELINE_VIEWS;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, TRAFFIC_TOP_PAGES);
  const out: RadarCandidate[] = [];
  for (const [path, total] of top) {
    const avg = total / baseline.length;
    if (avg < TRAFFIC_MIN_BASELINE_VIEWS) continue;
    const lastViews = last.topPaths.find((p) => p.path === path)?.views ?? 0;
    if (lastViews > avg * (1 - TRAFFIC_DROP_PCT)) continue;
    const ref = parseStorefrontPath(path);
    if (ref.entityType !== "home" && ref.entityType !== "product") continue; // cart/search pages are not refreshable sections
    const dropPct = Math.round((1 - lastViews / avg) * 100);
    const target = ref.entityType === "home" ? ("home" as const) : ("pdp" as const);
    const label = pageLabel(ref);
    const productId = last.topPaths.find((p) => p.path === path)?.productId
      ?? baseline.flatMap((d) => d.topPaths).find((p) => p.path === path)?.productId
      ?? null;
    out.push({
      kind: "section_refresh",
      dedupKey: `traffic-drop:${path}`,
      headline: `${label} lost ${dropPct}% of its visits`,
      rationale:
        `${label} averaged ${Math.round(avg)} views a day over the last week but got ${lastViews} yesterday. ` +
        `A refreshed section can re-engage shoppers; nothing changes until you apply it.`,
      evidence: {
        chips: [`${Math.round(avg)}/day average`, `${lastViews} yesterday`, `down ${dropPct}%`],
        facts: { path, avg, lastViews, dropPct },
      },
      payload: {
        applyMode: "refresh_section",
        target,
        path,
        ...(ref.handle ? { handle: ref.handle } : {}),
        ...(productId ? { productId } : {}),
        brief: sectionBrief(
          target,
          `Context: the page at ${path} (about "${(ref.handle ?? "the store").replace(/-/g, " ")}") lost ${dropPct}% of its daily visits this week.`,
        ),
      },
    });
  }
  return out;
}

export function detectConversionGaps(days: TrafficDay[]): RadarCandidate[] {
  const last7 = sortedDays(days).slice(-7);
  const acc = new Map<string, { views: number; cartAdds: number; handle: string | null; path: string }>();
  for (const d of last7) {
    for (const p of d.topPaths) {
      if (!p.productId) continue;
      const cur = acc.get(p.productId) ?? {
        views: 0, cartAdds: 0, handle: parseStorefrontPath(p.path).handle, path: p.path,
      };
      cur.views += p.views;
      cur.cartAdds += p.cartAdds;
      acc.set(p.productId, cur);
    }
  }
  const out: RadarCandidate[] = [];
  for (const [productId, s] of acc) {
    if (s.views < CONV_GAP_MIN_VIEWS) continue;
    if (s.cartAdds / s.views >= CONV_GAP_MAX_CART_RATE) continue;
    const label = s.handle ? `"${s.handle.replace(/-/g, " ")}"` : "This product";
    out.push({
      kind: "section_refresh",
      dedupKey: `conv-gap:${productId}`,
      headline: `${label} gets looks, not carts`,
      rationale:
        `${s.views} people viewed ${label} this week but only ${s.cartAdds} added it to a cart ` +
        `(under 1%). A stronger product-page section can help close the gap.`,
      evidence: {
        chips: [`${s.views} views`, `${s.cartAdds} cart adds`, "under 1%"],
        facts: { productId, views: s.views, cartAdds: s.cartAdds, path: s.path },
      },
      payload: {
        applyMode: "refresh_section",
        target: "pdp",
        productId,
        ...(s.handle ? { handle: s.handle } : {}),
        path: s.path,
        brief: sectionBrief(
          "pdp",
          `Context: ${s.views} shoppers viewed this product this week but under 1% added it to a cart; make the value clearer.`,
        ),
      },
    });
  }
  return out;
}

export function detectStaleHome(
  days: TrafficDay[],
  lastPublishedAt: string | null,
  now: Date = new Date(),
): RadarCandidate[] {
  if (!lastPublishedAt) return [];
  const publishedAt = Date.parse(lastPublishedAt);
  if (!Number.isFinite(publishedAt)) return [];
  const ageWeeks = (now.getTime() - publishedAt) / (7 * DAY_MS);
  if (ageWeeks < STALE_SECTION_WEEKS) return [];
  const sorted = sortedDays(days);
  if (sorted.length < 14) return [];
  const homeViews = (d: TrafficDay): number =>
    d.topPaths.filter((p) => parseStorefrontPath(p.path).entityType === "home").reduce((n, p) => n + p.views, 0);
  const last7 = sorted.slice(-7).reduce((n, d) => n + homeViews(d), 0);
  const prior7 = sorted.slice(-14, -7).reduce((n, d) => n + homeViews(d), 0);
  if (prior7 === 0 || last7 > prior7 * STALE_DECLINE_RATIO) return [];
  const weeks = Math.floor(ageWeeks);
  return [{
    kind: "section_refresh",
    dedupKey: "stale:home",
    headline: "Your home page hasn't changed in a while",
    rationale:
      `Your home page was last updated ${weeks} weeks ago and its views slipped from ${prior7} to ${last7} ` +
      `week over week. A fresh hero section keeps returning shoppers looking.`,
    evidence: {
      chips: [`${weeks} weeks unchanged`, `${prior7} -> ${last7} weekly views`],
      facts: { lastPublishedAt, weeks, prior7, last7 },
    },
    payload: {
      applyMode: "refresh_section",
      target: "home",
      path: "/storefront",
      brief: sectionBrief("home", `Context: the home page has not changed in ${weeks} weeks and weekly views are declining.`),
    },
  }];
}

export function detectAeoQuiet(
  crawl: AiCrawlDay[],
  opts: { allowAiCrawlers: boolean; hasOrgDescription: boolean },
  now: Date = new Date(),
): RadarCandidate[] {
  if (!opts.allowAiCrawlers) return []; // the merchant turned AI access off - respect it
  // Inclusive `>= quietFrom`, so subtract AEO_QUIET_DAYS-1 to make the "recent"
  // window exactly the last AEO_QUIET_DAYS calendar dates. Subtracting the full
  // AEO_QUIET_DAYS would span one extra day and let a hit exactly a week old
  // read as "still active".
  const quietFrom = isoDay(new Date(now.getTime() - (AEO_QUIET_DAYS - 1) * DAY_MS));
  const recentHits = crawl.filter((c) => c.day >= quietFrom).reduce((n, c) => n + c.hits, 0);
  const priorHits = crawl.filter((c) => c.day < quietFrom).reduce((n, c) => n + c.hits, 0);
  if (recentHits > 0 || priorHits < AEO_MIN_PRIOR_HITS) return [];
  const applyMode = opts.hasOrgDescription ? ("review" as const) : ("refresh_org" as const);
  return [{
    kind: "aeo_refresh",
    dedupKey: "aeo-quiet",
    headline: "AI assistants stopped reading your store",
    rationale: opts.hasOrgDescription
      ? `AI assistants (like ChatGPT and Claude) read your store ${priorHits} times recently but haven't visited in a week. ` +
        `Your store description is set - review your Preferences to make sure everything is current.`
      : `AI assistants (like ChatGPT and Claude) read your store ${priorHits} times recently but haven't visited in a week. ` +
        `Adding a store description gives them something concrete to quote when shoppers ask.`,
    evidence: {
      chips: [`${priorHits} earlier visits`, `0 this week`],
      facts: { priorHits, recentHits, quietFrom },
    },
    payload: applyMode === "review"
      ? { applyMode, deepLink: "/dashboard/store/preferences" }
      : { applyMode },
  }];
}

export function detectJsonLdIssues(pages: JsonLdCheckedPage[]): RadarCandidate[] {
  const out: RadarCandidate[] = [];
  for (const p of pages) {
    if (p.issues.length === 0) continue;
    out.push({
      kind: "aeo_jsonld_fix",
      dedupKey: `jsonld:product:${p.productId}`,
      headline: `"${p.title}" is missing details search tools need`,
      rationale:
        `Google and AI assistants read structured product details behind the scenes, and "${p.title}" ` +
        `is missing some (${p.issues.join("; ")}). Filling in the product's real data fixes this - ` +
        `Radar won't invent prices or availability for you.`,
      evidence: { chips: p.issues.slice(0, 3), facts: { productId: p.productId, issues: p.issues } },
      payload: { applyMode: "review", productId: p.productId, handle: p.handle, deepLink: `/dashboard/products/${p.productId}` },
    });
  }
  return out;
}

/** Everything, in a stable order (SEO first - they are the cheapest wins). */
export function detectAll(inputs: RadarCollectInputs, now: Date = new Date()): RadarCandidate[] {
  return [
    ...detectRankingSlips(inputs.rankings),
    ...detectCtrLow(inputs.rankings),
    ...detectRisingQueries(inputs.rankings),
    ...detectAeoQuiet(inputs.aiCrawl, {
      allowAiCrawlers: inputs.allowAiCrawlers,
      hasOrgDescription: inputs.hasOrgDescription,
    }, now),
    ...detectJsonLdIssues(inputs.jsonLdIssues),
    ...detectTrafficDrops(inputs.traffic),
    ...detectConversionGaps(inputs.traffic),
    ...detectStaleHome(inputs.traffic, inputs.lastPublishedAt, now),
  ];
}
