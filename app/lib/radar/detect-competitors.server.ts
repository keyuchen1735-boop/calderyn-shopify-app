// Pure detectors over competitor snapshot diffs (same style as
// detect.server.ts: no DB, no Claude, thresholds as named constants,
// evidence limited to facts actually present in the stored diff).
//
// Two families, BOTH aggregated per competitor (dedup key has no page/date
// component, so only ONE open move of each kind can exist per competitor at a
// time) - this is a deliberate product decision (not an implementation
// shortcut): an uncluttered move queue wins over surfacing every individual
// page change, so additional signals from the same competitor while a move is
// open, or still cooling down after being resolved, are intentionally
// absorbed rather than queued as new moves. Without this, a single site-wide
// sale or relaunch could draft up to one move per changed page per night.
//  - competitor_price: a comparable price MOVED (both a removed and a new
//    price on the same page) on one or more of the competitor's pages.
//    Informational ALWAYS - review mode + deep link to the merchant's own
//    pricing; applying just marks it done. Dedup key is `comp-price:{competitorId}`.
//  - competitor_counter: positioning/copy change or new page/product signals
//    (title change, or 2+ new headings). Counter = refresh the merchant's OWN
//    home hero via apply-time generation. Dedup key is `comp-counter:{competitorId}`.
import type { CompetitorDiffInput, RadarCandidate } from "./types";

/** A "positioning shift" needs a title change or at least this many new headings. */
export const SHIFT_MIN_NEW_HEADINGS = 2;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function pageLabel(url: string): string {
  const path = pathOf(url).replace(/\/+$/, "");
  if (!path || path === "") return "their home page";
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return last ? `their "${last.replace(/-/g, " ")}" page` : "their home page";
}

export function detectCompetitorPriceMoves(diffs: CompetitorDiffInput[]): RadarCandidate[] {
  // Aggregate per competitor: one price move covering every changed page, same
  // as detectCompetitorShifts' comp-counter - a site-wide sale must draft ONE
  // move per competitor per night, not one per changed page.
  const byCompetitor = new Map<string, { name: string; rows: CompetitorDiffInput[] }>();
  for (const d of diffs) {
    const hasLabeledChange = (d.diff.priceChanges ?? []).length > 0;
    const hasSetDifference = d.diff.newPrices.length > 0 && d.diff.removedPrices.length > 0;
    if (!hasLabeledChange && !hasSetDifference) continue;
    const entry = byCompetitor.get(d.competitorId) ?? { name: d.competitorName, rows: [] };
    entry.rows.push(d);
    byCompetitor.set(d.competitorId, entry);
  }

  const out: RadarCandidate[] = [];
  for (const [competitorId, { name, rows }] of byCompetitor) {
    // Truthfulness contract (see CompetitorDiff in types.ts): newPrices/removedPrices
    // are unordered page-wide set differences - nothing ties removedPrices[0] to
    // newPrices[0], so they can only back a generic "pricing changed" claim. Only
    // priceChanges pairs a price with the heading it was captured near on both
    // sides of the diff, so ONLY that field may name a page/product and show a
    // was->now pairing.
    const allPriceChanges = rows.flatMap((r) => r.diff.priceChanges ?? []);
    const hasLabeledChange = allPriceChanges.length > 0;
    // Every labeled pairing counts as one change; every page whose ONLY signal
    // is the generic set-difference (no priceChanges of its own) counts as one
    // more, so "and N more" reflects every changed page, not just labeled ones.
    const genericOnlyPageCount = rows.filter((r) => (r.diff.priceChanges ?? []).length === 0).length;
    const totalChanges = allPriceChanges.length + genericOnlyPageCount;

    const pages = rows.map((r) => ({
      url: r.url,
      capturedAt: r.capturedAt,
      newPrices: r.diff.newPrices,
      removedPrices: r.diff.removedPrices,
      priceChanges: r.diff.priceChanges ?? [],
    }));
    const baseFacts = { competitorId, pages };
    const firstUrl = rows[0].url;

    if (hasLabeledChange) {
      const [first] = allPriceChanges;
      const moreCount = totalChanges - 1;
      const more =
        moreCount > 0 ? ` (and ${moreCount} more change${moreCount === 1 ? "" : "s"})` : "";
      out.push({
        kind: "competitor_price",
        dedupKey: `comp-price:${competitorId}`,
        headline: `${name} changed their prices`,
        rationale:
          `${first.label}: ${first.from} is now ${first.to} at ${name}.${more} ` +
          `Worth a quick look at your own prices - nothing changes unless you decide to.`,
        evidence: {
          chips: [name, `${first.label}: was ${first.from}`, `now ${first.to}`],
          // pricingClaim marks this move as safe to polish for the drafter -
          // see FIX 4 in draft.server.ts: only "labeled" copy may be sent to
          // Claude, since it already names a specific product's was->now move.
          facts: { ...baseFacts, priceChanges: allPriceChanges, pricingClaim: "labeled" as const },
        },
        payload: { applyMode: "review", deepLink: "/dashboard/products", competitorId, url: firstUrl },
      });
      continue;
    }

    // Set-difference only, across every changed page: generic copy, no
    // was/now pairing anywhere.
    const pagesPhrase = rows.length === 1 ? pageLabel(rows[0].url) : `${rows.length} pages`;
    out.push({
      kind: "competitor_price",
      dedupKey: `comp-price:${competitorId}`,
      headline: `Pricing changed at ${name}`,
      rationale:
        `${name} changed prices on ${pagesPhrase}. ` +
        `Take a look and decide if your own pricing still stands up.`,
      evidence: {
        chips: [name, rows.length === 1 ? pagesPhrase.replace(/^their /, "") : `${rows.length} pages changed`],
        // Generic (unpaired) copy must NEVER be polished by Claude - facts here
        // carry no was->now pairing for the model to invent one from. See
        // draft.server.ts's polish gate, which reads this marker.
        facts: { ...baseFacts, pricingClaim: "generic" as const },
      },
      payload: { applyMode: "review", deepLink: "/dashboard/products", competitorId, url: firstUrl },
    });
  }
  return out;
}

export function detectCompetitorShifts(diffs: CompetitorDiffInput[]): RadarCandidate[] {
  // Aggregate per competitor: one counter move covering every shifted page.
  const byCompetitor = new Map<string, { name: string; rows: CompetitorDiffInput[] }>();
  for (const d of diffs) {
    const shifted = d.diff.titleChanged !== null || d.diff.newHeadings.length >= SHIFT_MIN_NEW_HEADINGS;
    if (!shifted) continue;
    const entry = byCompetitor.get(d.competitorId) ?? { name: d.competitorName, rows: [] };
    entry.rows.push(d);
    byCompetitor.set(d.competitorId, entry);
  }
  const out: RadarCandidate[] = [];
  for (const [competitorId, { name, rows }] of byCompetitor) {
    const newHeadings = rows.flatMap((r) => r.diff.newHeadings).slice(0, 5);
    const titleChange = rows.map((r) => r.diff.titleChanged).find((t) => t !== null) ?? null;
    const what = titleChange
      ? `changed their headline messaging ("${titleChange.from}" is now "${titleChange.to}")`
      : `added new sections (${newHeadings.map((h) => `"${h}"`).join(", ")})`;
    out.push({
      kind: "competitor_counter",
      dedupKey: `comp-counter:${competitorId}`,
      headline: `${name} refreshed their store - answer with yours`,
      rationale:
        `${name} recently ${what}. A refreshed home hero keeps your own story sharp. ` +
        `Nothing changes on your store until you apply it.`,
      evidence: {
        chips: [name, `${rows.length} page${rows.length === 1 ? "" : "s"} changed`],
        facts: {
          competitorId,
          pages: rows.map((r) => ({ url: r.url, capturedAt: r.capturedAt, diff: r.diff })),
        },
      },
      payload: {
        applyMode: "refresh_section",
        target: "home",
        competitorId,
        brief:
          "Refresh the home page's hero section: rewrite the headline and supporting copy so this store's " +
          "own strengths and current offering are front and center. Context: a competing store recently " +
          `updated its messaging (${what}). Do not mention the competitor by name and do not copy their ` +
          "wording. Keep the products, prices, layout structure and navigation unchanged.",
      },
    });
  }
  return out;
}

export function detectCompetitors(diffs: CompetitorDiffInput[]): RadarCandidate[] {
  return [...detectCompetitorPriceMoves(diffs), ...detectCompetitorShifts(diffs)];
}
