// app/lib/screener/campaign-regen.server.ts
// Deterministic core of per-campaign Regenerate: from the campaign's CACHED ad
// scorecards, pick the weakest scored ad, re-load its persisted run for the
// original creative + scorecard, run the generate->re-score gate seeded from it,
// keep winners, and persist them onto that run. All I/O is injected (rule 5: the
// math/selection is deterministic code; the model only runs behind the injected
// gate). Never throws on a normal degraded state — it returns a typed reason.
import { generateImprovements, type GateDeps } from "./generate.server";
import type { AdScorecard } from "./campaign-ads.server";
import type { CreativeScreenRun, Variant } from "./types";

export interface RegenerateDeps {
  loadCached: (shop: string, adIds: string[]) => Promise<AdScorecard[]>;
  getLatestRunForAd: (shop: string, metaAdId: string) => Promise<CreativeScreenRun | null>;
  gate: GateDeps; // { generator, scoreOne }
  styleRefs: string[];
  saveVariants: (shop: string, runId: string, variants: Variant[]) => Promise<CreativeScreenRun>;
  generate?: typeof generateImprovements;
  count?: number;
}

export type RegenerateResult =
  | {
      ok: true;
      runId: string;
      weakestAdId: string;
      variants: Variant[];
      allScored: Variant[];
      generated: number;
      discarded: number;
    }
  | { ok: false; reason: "no_scored_ads" | "no_seed_run" | "generator_unavailable" };

/** PURE: the worst-scoring cached ad (lowest composite among status:"done"). */
export function pickWeakestScoredAd(cards: AdScorecard[]): AdScorecard | null {
  let best: { card: AdScorecard; composite: number } | null = null;
  for (const c of cards) {
    if (c.status !== "done" || !c.scorecard) continue;
    const composite = c.scorecard.composite;
    if (best === null || composite < best.composite) best = { card: c, composite };
  }
  return best ? best.card : null;
}

export async function regenerateCampaignCreative(
  shop: string,
  adIds: string[],
  deps: RegenerateDeps,
): Promise<RegenerateResult> {
  const cards = await deps.loadCached(shop, adIds);
  const weakest = pickWeakestScoredAd(cards);
  if (!weakest) return { ok: false, reason: "no_scored_ads" };

  const seed = await deps.getLatestRunForAd(shop, weakest.adId);
  if (!seed || seed.status !== "done" || !seed.scorecard || !seed.creativeInput) {
    return { ok: false, reason: "no_seed_run" };
  }

  const generate = deps.generate ?? generateImprovements;
  const result = await generate(
    {
      original: seed.creativeInput,
      originalScorecard: seed.scorecard,
      styleRefs: deps.styleRefs,
      count: deps.count,
    },
    deps.gate,
  );
  if (!result.available) return { ok: false, reason: "generator_unavailable" };

  const saved = await deps.saveVariants(shop, seed.id, result.variants);
  return {
    ok: true,
    runId: saved.id,
    weakestAdId: weakest.adId,
    variants: result.variants,
    allScored: result.allScored,
    generated: result.generated,
    discarded: result.discarded,
  };
}
