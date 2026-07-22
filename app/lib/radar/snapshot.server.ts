// Nightly competitor snapshots. Deterministic end to end: normalize -> sha256
// -> bounded regex extraction -> diff vs previous snapshot. The hash gate
// means an unchanged page writes NO row and costs zero Claude; a changed page
// still costs zero Claude here (the drafter's quota-gated polish is the only
// model touch competitor moves ever get). Politeness lives in fetch.server.ts;
// this module adds the page/fetch budgets and the cron deadline.
import { createHash } from "node:crypto";
import {
  insertSnapshot,
  latestSnapshots,
  listCompetitors,
  MAX_WATCHED_COMPETITORS,
  touchCompetitorSnapshot,
} from "./competitor-store.server";
import { isPathAllowed, loadRobots, politeFetch } from "./fetch.server";
import type { CompetitorDiff, CompetitorExtract } from "./types";

export const MAX_PAGES_PER_COMPETITOR = 10;
/** Hard cap on outbound requests per shop per night (robots + pages, all
 *  competitors). Keeps a worst-case night inside the cron's 50s budget. */
export const SNAPSHOT_FETCH_BUDGET = 30;

const MAX_TEXT_CHARS = 500_000;
const MAX_LIST = 20;
const MAX_ITEM_CHARS = 160;

export function normalizeText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

/** Matches a complete money token in either thousands/decimal convention:
 *  "$1,299.00" (US), "€1.299,00" (EU), "£999" (no decimal), "$29.99" (simple),
 *  and grouping-free four-plus-digit prices like "$1500" / "$1500.00" that a
 *  theme may render without a thousands separator. The leading integer part is
 *  \d+ (not \d{1,3}) so those larger comma-less prices are captured rather than
 *  silently dropped; the trailing (?!\d) tail guard still forces the match to
 *  consume the whole number instead of stopping mid-token. */
const PRICE_RE = /[$£€]\s?\d+(?:[.,]\d{3})*(?:[.,]\d{2})?(?!\d)/g;
/** Nearest-heading correlation window, in characters of source HTML. */
const LABEL_PROXIMITY_CHARS = 500;

export function contentHash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function stripTags(fragment: string): string {
  return fragment.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
}

/** Matches a <meta name="description" content="..."> tag in either
 *  attribute order (name-then-content or content-then-name). */
const META_DESCRIPTION_RE =
  /<meta[^>]+(?:name=["']description["'][^>]*content=["']([^"']*)["']|content=["']([^"']*)["'][^>]*name=["']description["'])[^>]*>/i;

export function extractFacts(html: string): CompetitorExtract {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const metaMatch = META_DESCRIPTION_RE.exec(html);
  const metaDescription = (metaMatch?.[1] ?? metaMatch?.[2] ?? "").trim().slice(0, MAX_ITEM_CHARS);

  // Scanned well past MAX_LIST (bounded, not unbounded) so labeledPrices can
  // still correlate against headings further down the page than the top 20
  // kept in `headings`.
  const headingMatches: Array<{ index: number; text: string }> = [];
  const headingRe = /<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi;
  for (let m = headingRe.exec(html); m && headingMatches.length < MAX_LIST * 10; m = headingRe.exec(html)) {
    const text = stripTags(m[1]);
    if (text) headingMatches.push({ index: m.index, text });
  }
  const headings = headingMatches.slice(0, MAX_LIST).map((h) => h.text);

  const prices: string[] = [];
  const normalized = normalizeText(html);
  const normalizedPriceRe = new RegExp(PRICE_RE);
  for (let m = normalizedPriceRe.exec(normalized); m && prices.length < MAX_LIST; m = normalizedPriceRe.exec(normalized)) {
    const price = m[0].replace(/\s+/g, "");
    if (!prices.includes(price)) prices.push(price);
  }

  // Labeled prices are correlated on the raw source HTML (not the normalized
  // text) so a price's index can be compared against a heading's index in
  // the same coordinate space.
  const labeledPrices: Array<{ label: string; price: string }> = [];
  const sourcePriceRe = new RegExp(PRICE_RE);
  for (let m = sourcePriceRe.exec(html); m && labeledPrices.length < MAX_LIST; m = sourcePriceRe.exec(html)) {
    const priceIndex = m.index;
    let nearest: { index: number; text: string } | null = null;
    for (const heading of headingMatches) {
      if (heading.index <= priceIndex && priceIndex - heading.index <= LABEL_PROXIMITY_CHARS) {
        if (!nearest || heading.index > nearest.index) nearest = heading;
      }
    }
    if (nearest) {
      labeledPrices.push({ label: nearest.text, price: m[0].replace(/\s+/g, "") });
    }
  }

  return {
    title,
    metaDescription,
    headings,
    prices,
    ...(labeledPrices.length > 0 ? { labeledPrices } : {}),
  };
}

/** Home first, then same-host store-shaped links (products/collections/shop/
 *  pages), capped. Anything else (cart, checkout, off-site) is ignored. */
export function discoverPageUrls(homeHtml: string, origin: string): string[] {
  const base = new URL(origin);
  const home = `${base.origin}/`;
  const interesting = /^\/(products?|collections?|shop|pages?|catalog)\//i;
  const urls: string[] = [home];
  const hrefRe = /href=["']([^"'#]+)["']/gi;
  for (let m = hrefRe.exec(homeHtml); m && urls.length < MAX_PAGES_PER_COMPETITOR; m = hrefRe.exec(homeHtml)) {
    let resolved: URL;
    try {
      resolved = new URL(m[1], base);
    } catch {
      continue;
    }
    if (resolved.origin !== base.origin) continue;
    if (!interesting.test(resolved.pathname)) continue;
    const clean = `${resolved.origin}${resolved.pathname}`;
    if (!urls.includes(clean)) urls.push(clean);
  }
  return urls;
}

function delta(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  return {
    added: next.filter((x) => !prev.includes(x)),
    removed: prev.filter((x) => !next.includes(x)),
  };
}

/** Prices whose label is UNIQUE on a side, keyed by label. A heading that
 *  labels two different prices (e.g. a grid where several cards share the
 *  heading "Featured") is ambiguous - it can't name a single product - so it
 *  is dropped rather than collapsed to whichever entry happened to come last. */
function uniqueLabeledPrices(
  entries: ReadonlyArray<{ label: string; price: string }>,
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  const unique = new Map<string, string>();
  for (const entry of entries) {
    if (counts.get(entry.label) === 1) unique.set(entry.label, entry.price);
  }
  return unique;
}

/** Labeled prices present on both sides, whose label carried a different
 *  price value each side. This is the only truthful basis for a
 *  specific-product price claim - see the contract on CompetitorDiff. A label
 *  must be unambiguous (appear once) on BOTH sides to back a claim: a duplicated
 *  heading would otherwise fabricate a was->now move for a product whose price
 *  never actually changed. */
function labeledPriceChanges(
  prev: CompetitorExtract,
  next: CompetitorExtract,
): Array<{ label: string; from: string; to: string }> | undefined {
  if (!prev.labeledPrices || !next.labeledPrices) return undefined;
  const prevByLabel = uniqueLabeledPrices(prev.labeledPrices);
  const nextByLabel = uniqueLabeledPrices(next.labeledPrices);
  const changes: Array<{ label: string; from: string; to: string }> = [];
  for (const [label, price] of nextByLabel) {
    const from = prevByLabel.get(label);
    if (from !== undefined && from !== price) {
      changes.push({ label, from, to: price });
    }
  }
  return changes.length > 0 ? changes : undefined;
}

/** Null when the extracts are equivalent (belt-and-braces behind the hash gate). */
export function diffExtracts(prev: CompetitorExtract, next: CompetitorExtract): CompetitorDiff | null {
  const headings = delta(prev.headings, next.headings);
  const prices = delta(prev.prices, next.prices);
  const titleChanged = prev.title !== next.title ? { from: prev.title, to: next.title } : null;
  const priceChanges = labeledPriceChanges(prev, next);
  if (!titleChanged && headings.added.length === 0 && headings.removed.length === 0
    && prices.added.length === 0 && prices.removed.length === 0 && !priceChanges) {
    return null;
  }
  return {
    titleChanged,
    newHeadings: headings.added,
    removedHeadings: headings.removed,
    newPrices: prices.added,
    removedPrices: prices.removed,
    ...(priceChanges ? { priceChanges } : {}),
  };
}

export interface SnapshotSummary {
  pagesFetched: number;
  pagesStored: number;
  failed: number;
}

/** Snapshot every watching competitor for one shop, inside the caller's
 *  deadline and the per-shop fetch budget. Per-competitor failures log and
 *  move on; a budget stop is not an error (next night resumes). Competitors
 *  are processed stalest-first via listCompetitors' updated_at ordering, and
 *  each attempted competitor is touched (updated_at bumped) so the tail
 *  rotates in on the next run rather than starving past the budget. */
export async function snapshotWatchingCompetitors(
  shopId: string,
  opts: { deadline: number; fetchImpl?: typeof fetch },
): Promise<SnapshotSummary> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const summary: SnapshotSummary = { pagesFetched: 0, pagesStored: 0, failed: 0 };
  const watching = await listCompetitors(shopId, ["watching"], MAX_WATCHED_COMPETITORS);
  let budget = SNAPSHOT_FETCH_BUDGET;

  for (const competitor of watching) {
    if (Date.now() >= opts.deadline || budget <= 0) break;
    try {
      const origin = new URL(competitor.url).origin;
      budget--;
      const robots = await loadRobots(origin, fetchImpl);
      if (robots.unreachable) {
        console.error(`[radar] robots.txt unreachable for ${origin}; skipping host tonight`);
        continue;
      }
      if (Date.now() >= opts.deadline || budget <= 0) break;
      if (!isPathAllowed(robots, "/")) continue;
      budget--;
      const home = await politeFetch(`${origin}/`, fetchImpl);
      summary.pagesFetched++;
      if (!home.ok) {
        summary.failed++;
        console.error(`[radar] snapshot fetch failed for ${origin}/: ${home.error}`);
        continue;
      }
      const pages = discoverPageUrls(home.text, origin);
      const baselines = await latestSnapshots(shopId, competitor.id);

      for (const pageUrl of pages) {
        if (Date.now() >= opts.deadline || budget < 0) break;
        const path = new URL(pageUrl).pathname;
        if (!isPathAllowed(robots, path)) continue;
        let html: string;
        if (pageUrl === `${origin}/`) {
          html = home.text; // already fetched
        } else {
          if (budget <= 0) break;
          budget--;
          const res = await politeFetch(pageUrl, fetchImpl);
          summary.pagesFetched++;
          if (!res.ok) {
            summary.failed++;
            console.error(`[radar] snapshot fetch failed for ${pageUrl}: ${res.error}`);
            continue;
          }
          html = res.text;
        }
        const hash = contentHash(normalizeText(html));
        const prev = baselines.get(pageUrl);
        if (prev && prev.contentHash === hash) continue; // unchanged: zero rows, zero Claude
        const extracted = extractFacts(html);
        const diff = prev ? diffExtracts(prev.extracted, extracted) : null; // first sight = baseline
        await insertSnapshot(shopId, { competitorId: competitor.id, url: pageUrl, contentHash: hash, extracted, diff });
        summary.pagesStored++;
      }
    } catch (err) {
      summary.failed++;
      console.error(`[radar] snapshot failed for competitor ${competitor.id} (${competitor.url})`, err);
    } finally {
      // Rotate this attempted competitor to the back of the stalest-first
      // queue so tail competitors are not starved past the fetch budget.
      try {
        await touchCompetitorSnapshot(shopId, competitor.id);
      } catch (touchErr) {
        console.error(`[radar] failed to rotate competitor ${competitor.id}`, touchErr);
      }
    }
  }
  return summary;
}
