// app/lib/campaign-score/aggregate.server.ts
// PURE (no I/O): fold a campaign's per-ad creative scorecards into a single
// creative half (mean composite), plus the aggregated weak dimensions and tips
// that drive the "How to improve" section. Errored/unscored cards are excluded
// from the mean but counted in coverage.total (rule 12 — surface the gap).
// NOTE (D1): paused-ad exclusion happens upstream in resolve.server.ts; this
// function averages whatever AdScorecard[] it is handed.
import type { AdScorecard } from "../screener/campaign-ads.server";
import type { ScoreCard } from "../screener/types";
import { normalizeTip } from "../screener/types";

const WEAK_DIMENSION_MAX = 65; // mirrors generate.server.ts weakMetrics cutoff
const WEAK_DIMENSION_LIMIT = 5;
const TIP_LIMIT = 5;

export function aggregateAdScorecards(ads: AdScorecard[]): {
  creativeComposite: number | null;
  weakDimensions: { label: string; score: number; adId: string }[];
  tips: string[];
  coverage: { covered: number; total: number };
} {
  const total = ads.length;
  const scored: { adId: string; card: ScoreCard }[] = ads.flatMap((a) =>
    a.status === "done" && a.scorecard != null ? [{ adId: a.adId, card: a.scorecard }] : [],
  );
  const coverage = { covered: scored.length, total };

  if (scored.length === 0) {
    return { creativeComposite: null, weakDimensions: [], tips: [], coverage };
  }

  const sum = scored.reduce((acc, s) => acc + s.card.composite, 0);
  const creativeComposite = Math.round(sum / scored.length);

  const weakDimensions = scored
    .flatMap((s) =>
      s.card.metrics
        .filter((m) => m.score < WEAK_DIMENSION_MAX)
        .map((m) => ({ label: m.label, score: m.score, adId: s.adId })),
    )
    .sort((x, y) => x.score - y.score)
    .slice(0, WEAK_DIMENSION_LIMIT);

  const seen = new Set<string>();
  const tips: string[] = [];
  for (const s of scored) {
    for (const t of s.card.tips) {
      const title = normalizeTip(t).title.trim();
      if (title && !seen.has(title)) {
        seen.add(title);
        tips.push(title);
      }
    }
  }

  return { creativeComposite, weakDimensions, tips: tips.slice(0, TIP_LIMIT), coverage };
}
