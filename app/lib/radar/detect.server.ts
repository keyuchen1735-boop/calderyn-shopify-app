// Deterministic Radar detectors: pure functions over collected rows. No DB, no
// Claude, no clock reads except via parameters - every threshold is a named
// exported constant so tests and tuning share one source of truth.
//
// Input contract: `series` arrives already bounded to the LAST 14 CALENDAR
// DAYS by the read_radar_ranking_series RPC (per page,query). Detectors below
// additionally enforce their own, narrower windows within that 14-day input
// (e.g. a 3-day sustain check, a 7-day CTR window) - never assume the RPC's
// 14-day bound alone is tight enough for a given detector's claim.
import type { RadarCandidate, RankingSeries } from "./types";

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
  const out: RadarCandidate[] = [];
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
    out.push({
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
    });
  }
  return out;
}
