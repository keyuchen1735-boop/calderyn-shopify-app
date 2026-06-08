// app/lib/screener/campaign-ads.server.ts
// Batch "cache + auto on load" for the campaign-detail page: for each Meta ad
// creative, reuse a persisted done run if one exists, else score+persist via the
// orchestrator. Per-ad isolation (Promise.allSettled): one ad failing never
// blocks the others, and a failure surfaces as an explicit error AdScorecard
// rather than a silent blank (rule 12).
import { executeScreen } from "./orchestrate.server";
import { getLatestRunForAd as realGetLatest } from "./runs.server";
import type { CreativeInput, CreativeScreenRun, RunSource, ScoreCard } from "./types";

export interface AdScorecard {
  adId: string;
  status: "done" | "error";
  scorecard: ScoreCard | null;
  error: string | null;
}

export interface ScoreAdsDeps {
  getLatestRunForAd: (shop: string, metaAdId: string) => Promise<CreativeScreenRun | null>;
  screen: (args: {
    shop: string;
    input: CreativeInput;
    assumedSpendCents: number;
    source: RunSource;
    metaAdId: string;
  }) => Promise<CreativeScreenRun>;
}

function defaultDeps(): ScoreAdsDeps {
  return {
    getLatestRunForAd: realGetLatest,
    screen: (a) =>
      executeScreen({
        shop: a.shop,
        input: a.input,
        assumedSpendCents: a.assumedSpendCents,
        source: a.source,
        metaAdId: a.metaAdId,
      }),
  };
}

/** Map a finished run to an AdScorecard, honestly surfacing missing scorecards. */
function runToAdScorecard(adId: string, run: CreativeScreenRun): AdScorecard {
  if (run.status === "done" && run.scorecard) {
    return { adId, status: "done", scorecard: run.scorecard, error: null };
  }
  return {
    adId,
    status: "error",
    scorecard: null,
    error: run.error ?? "Scoring produced no scorecard.",
  };
}

async function loadOrScoreOne(
  shop: string,
  adId: string,
  creative: CreativeInput,
  assumedSpendCents: number,
  deps: ScoreAdsDeps,
): Promise<AdScorecard> {
  if (!adId) {
    // No Meta ad id → cannot cache or persist a run keyed to it. Surface the gap
    // instead of silently dropping the ad (rule 12).
    return { adId, status: "error", scorecard: null, error: "Ad is missing a Meta ad id." };
  }
  const cached = await deps.getLatestRunForAd(shop, adId);
  if (cached && cached.status === "done" && cached.scorecard) {
    return runToAdScorecard(adId, cached);
  }
  const run = await deps.screen({
    shop,
    input: creative,
    assumedSpendCents,
    source: "meta_ad",
    metaAdId: adId,
  });
  return runToAdScorecard(adId, run);
}

export async function loadOrScoreAdScorecards(
  shop: string,
  creatives: { adId: string; creative: CreativeInput }[],
  assumedSpendCents: number,
  deps: ScoreAdsDeps = defaultDeps(),
): Promise<AdScorecard[]> {
  // Dedupe by adId so the same ad submitted twice in one batch fires ONE paid
  // Claude run, not two. Score each distinct adId once (keeping the first
  // creative seen for it), then map the result back to every position with that
  // adId — preserving output order + length. Empty adIds are NOT deduped (each
  // is independently surfaced as an error by loadOrScoreOne).
  const firstIndexByAd = new Map<string, number>();
  const distinct: { adId: string; creative: CreativeInput }[] = [];
  for (const c of creatives) {
    if (c.adId && firstIndexByAd.has(c.adId)) continue;
    if (c.adId) firstIndexByAd.set(c.adId, distinct.length);
    distinct.push(c);
  }

  const settled = await Promise.allSettled(
    distinct.map((c) =>
      loadOrScoreOne(shop, c.adId, c.creative, assumedSpendCents, deps),
    ),
  );
  const scoredDistinct: AdScorecard[] = settled.map((res, i) => {
    if (res.status === "fulfilled") return res.value;
    const message = res.reason instanceof Error ? res.reason.message : String(res.reason);
    return { adId: distinct[i].adId, status: "error", scorecard: null, error: message };
  });

  // Map each input position back to its scored result. Distinct non-empty adIds
  // index into scoredDistinct via firstIndexByAd; empty adIds were appended in
  // order, so consume them positionally as we encounter them.
  let emptyCursor = 0;
  const emptyResults = scoredDistinct.filter((s) => !s.adId);
  return creatives.map((c) => {
    if (c.adId) {
      const idx = firstIndexByAd.get(c.adId);
      if (idx !== undefined) return scoredDistinct[idx];
    }
    return emptyResults[emptyCursor++];
  });
}

// Cache-only: one getLatestRunForAd per ad, NO scoring. Returns an AdScorecard
// (status "done") only for ads that already have a persisted done run with a
// non-null scorecard; ads without a cached run are omitted from the result.
// Per-ad isolation (allSettled): a single failing read never throws out of the
// batch (rule 12) — it is simply omitted, and the client will stream that ad.
export async function loadCachedAdScorecards(
  shop: string,
  adIds: string[],
  deps: { getLatestRunForAd: (shop: string, metaAdId: string) => Promise<CreativeScreenRun | null> } = {
    getLatestRunForAd: realGetLatest,
  },
): Promise<AdScorecard[]> {
  const settled = await Promise.allSettled(
    adIds.map(async (adId): Promise<AdScorecard | null> => {
      if (!adId) return null;
      const cached = await deps.getLatestRunForAd(shop, adId);
      if (cached && cached.status === "done" && cached.scorecard) {
        return runToAdScorecard(adId, cached);
      }
      return null;
    }),
  );
  const out: AdScorecard[] = [];
  for (const res of settled) {
    if (res.status === "fulfilled" && res.value) out.push(res.value);
  }
  return out;
}
