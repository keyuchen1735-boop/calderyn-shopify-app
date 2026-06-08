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
    return { adId, status: "done", scorecard: cached.scorecard, error: null };
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
  const settled = await Promise.allSettled(
    creatives.map((c) =>
      loadOrScoreOne(shop, c.adId, c.creative, assumedSpendCents, deps),
    ),
  );
  return settled.map((res, i) => {
    if (res.status === "fulfilled") return res.value;
    const message = res.reason instanceof Error ? res.reason.message : String(res.reason);
    return { adId: creatives[i].adId, status: "error", scorecard: null, error: message };
  });
}
