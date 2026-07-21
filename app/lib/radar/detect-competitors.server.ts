// Pure detectors over competitor snapshot diffs (same style as
// detect.server.ts: no DB, no Claude, thresholds as named constants,
// evidence limited to facts actually present in the stored diff).
//
// Two families:
//  - competitor_price: a comparable price MOVED (both a removed and a new
//    price on the same page). Informational ALWAYS - review mode + deep link
//    to the merchant's own pricing; applying just marks it done.
//  - competitor_counter: positioning/copy change or new page/product signals
//    (title change, or 2+ new headings). Counter = refresh the merchant's OWN
//    home hero via apply-time generation; ONE open counter per competitor
//    (dedup on the competitor id) so a busy rival cannot flood the queue.
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
  const out: RadarCandidate[] = [];
  for (const d of diffs) {
    if (d.diff.newPrices.length === 0 || d.diff.removedPrices.length === 0) continue;
    const was = d.diff.removedPrices[0];
    const now = d.diff.newPrices[0];
    out.push({
      kind: "competitor_price",
      dedupKey: `comp-price:${d.competitorId}:${pathOf(d.url)}`,
      headline: `${d.competitorName} changed their prices`,
      rationale:
        `${d.competitorName} changed pricing on ${pageLabel(d.url)} (for example ${was} is now ${now}). ` +
        `Worth a quick look at your own prices - nothing changes unless you decide to.`,
      evidence: {
        chips: [d.competitorName, `was ${was}`, `now ${now}`],
        facts: {
          competitorId: d.competitorId,
          url: d.url,
          newPrices: d.diff.newPrices,
          removedPrices: d.diff.removedPrices,
          capturedAt: d.capturedAt,
        },
      },
      payload: { applyMode: "review", deepLink: "/dashboard/products", competitorId: d.competitorId, url: d.url },
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
