// app/lib/screener/campaign-creatives-load.server.ts
// Dashboard mirror of the embedded campaign-detail creative load
// (app.campaigns.$campaignId.tsx loadCreatives + loadCachedScorecards): resolve
// the campaign's Meta external id, list its ad creatives, and merge CACHED per-ad
// scorecards (no scoring here — uncached ads are scored on demand via the score
// endpoint). Never throws: Meta-disconnected / missing-id / fetch-failure each
// degrade to an honest empty result with flags (rule 12, spec §9).
import { getSupabase } from "../supabase.server";
import { metaClientForShop } from "../meta/client.server";
import { listCampaignCreatives, type CampaignCreative } from "../meta/creatives.server";
import { loadCachedAdScorecards, type AdScorecard } from "./campaign-ads.server";
import type { MetaClient } from "../meta/campaigns.server";
import { DEFAULT_SPEND_CENTS, MAX_SPEND_CENTS, MIN_SPEND_CENTS } from "./types";

export interface CampaignCreativesPayload {
  creatives: CampaignCreative[];
  scorecards: AdScorecard[];
  assumedSpendCents: number;
  metaConnected: boolean;
  creativesError: string | null;
}

export interface CreativesLoadDeps {
  resolveMetaId: (shopId: string, campaignId: string) => Promise<string | null>;
  metaClient: (shopDomain: string) => Promise<{ client: MetaClient; adAccountId: string } | null>;
  listCreatives: (client: MetaClient, externalId: string) => Promise<CampaignCreative[]>;
  loadCached: (shop: string, adIds: string[]) => Promise<AdScorecard[]>;
}

// campaign UUID (ad_campaign_dim.id) → Meta campaign external id, shop-scoped.
// Same lookup the executor uses (execute.server ownership/resolve).
async function resolveMetaIdReal(shopId: string, campaignId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("ad_campaign_dim")
    .select("external_id")
    .eq("id", campaignId)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error || !data) return null;
  return (data.external_id as string | null) ?? null;
}

function defaultDeps(): CreativesLoadDeps {
  return {
    resolveMetaId: resolveMetaIdReal,
    metaClient: metaClientForShop,
    listCreatives: listCampaignCreatives,
    loadCached: loadCachedAdScorecards,
  };
}

function clampSpend(raw: number): number {
  const n = Number.isFinite(raw) ? Math.round(raw) : DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

export async function loadCampaignCreativeScorecards(
  shopDomain: string,
  shopId: string,
  campaignId: string,
  assumedSpendCents: number,
  deps: CreativesLoadDeps = defaultDeps(),
): Promise<CampaignCreativesPayload> {
  const spend = clampSpend(assumedSpendCents);
  const conn = await deps.metaClient(shopDomain);
  if (!conn) {
    return { creatives: [], scorecards: [], assumedSpendCents: spend, metaConnected: false, creativesError: null };
  }
  const externalId = await deps.resolveMetaId(shopId, campaignId);
  if (!externalId) {
    return { creatives: [], scorecards: [], assumedSpendCents: spend, metaConnected: true, creativesError: null };
  }
  let creatives: CampaignCreative[] = [];
  let creativesError: string | null = null;
  try {
    creatives = await deps.listCreatives(conn.client, externalId);
  } catch (err) {
    creativesError = err instanceof Error ? err.message : String(err);
  }
  let scorecards: AdScorecard[] = [];
  if (creatives.length > 0) {
    try {
      scorecards = await deps.loadCached(shopDomain, creatives.map((c) => c.adId));
    } catch {
      scorecards = [];
    }
  }
  return { creatives, scorecards, assumedSpendCents: spend, metaConnected: true, creativesError };
}
