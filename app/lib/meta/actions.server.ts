// Meta campaign actions over a MetaClient. pause/resume post campaign status;
// budget posts daily_budget (account minor units, as a string per the Graph API).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { ActionAdapter, CampaignActionState, RegionCode } from "../ads/actions";
import { ActionError } from "../ads/actions";
import { regionStateNames } from "../ads/geo-regions";
import { withRetry, type RetryOptions } from "../ads/backoff";
import { assertNotRateLimited, type MetaClient, type MetaResponse } from "./campaigns.server";
import { throttleMetaClient } from "./throttle.server";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// In-process absorption of brief Graph throttles (code 80004 etc.), matching
// the ingest adapter's policy. A call still throttled after the cap surfaces
// RateLimitError, which isRetriableFailure treats as transient — the executor
// parks the action `retrying` for the action-retry cron instead of failing.
const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, baseDelayMs: 500 };

// Graph API top-level error codes that are PERMANENT for a write action — the
// target object is gone (100), the access token is dead (190), or the app/user
// lacks permission (200/10/803/272). Parking these as `retrying` burns the
// action-retry budget against an action that can never succeed AND surfaces a
// not-yet-failed result the dashboard reports as a false success (P0-1). Fail
// them terminally; every other Graph error stays default-retriable so a
// transient blip doesn't lose the recovery (rate-limit codes are handled by
// assertNotRateLimited first).
const META_PERMANENT_CODES = new Set([100, 190, 200, 10, 803, 272]);

function check(r: MetaResponse): MetaResponse {
  assertNotRateLimited(r);
  if (r.error) {
    const code = r.error.code;
    const codeStr = code != null ? ` (code ${code})` : "";
    throw new ActionError("meta", `${r.error.message}${codeStr}`, {
      retriable: !(code != null && META_PERMANENT_CODES.has(code)),
    });
  }
  return r;
}

// --- geo exclusion (ad-set targeting) --------------------------------------
//
// Meta exclusion lives on each ad set's targeting.excluded_geo_locations.regions
// (an array of { key } where key is Meta's numeric region id). Meta publishes no
// US-state geo CSV, so the key is resolved at runtime from the adgeolocation
// targeting-search API (see resolveRegionKeys) — the merge/drop logic below is
// pure and key-agnostic.

/** A Meta region targeting ref; `key` is Meta's numeric region id. */
export type MetaRegionRef = { key: string | number; [k: string]: unknown };
/** The targeting spec subset we read/merge; sibling fields pass through untouched. */
export interface MetaTargeting {
  excluded_geo_locations?: { regions?: MetaRegionRef[]; [k: string]: unknown };
  [k: string]: unknown;
}

type MetaAdSet = { id: string; targeting?: MetaTargeting };
type MetaGeoSearchResult = { key?: string | number; name?: string; type?: string; country_code?: string };

function excludedRegions(t: MetaTargeting): MetaRegionRef[] {
  const r = t.excluded_geo_locations?.regions;
  return Array.isArray(r) ? r : [];
}

/** Add region keys to a targeting's excluded regions (union by key); existing
 * excluded regions and sibling fields (cities, countries, included targeting)
 * are preserved unchanged. Pure. */
export function mergeExcludedRegions(t: MetaTargeting, keys: string[]): MetaTargeting {
  const existing = excludedRegions(t);
  const have = new Set(existing.map((r) => String(r.key)));
  const additions = keys.filter((k) => !have.has(k)).map((key) => ({ key }));
  return {
    ...t,
    excluded_geo_locations: { ...(t.excluded_geo_locations ?? {}), regions: [...existing, ...additions] },
  };
}

/** Remove the given region keys from a targeting's excluded regions (undo of
 * mergeExcludedRegions); any other excluded region is kept. Pure. */
export function dropExcludedRegions(t: MetaTargeting, keys: string[]): MetaTargeting {
  const remove = new Set(keys);
  const kept = excludedRegions(t).filter((r) => !remove.has(String(r.key)));
  return {
    ...t,
    excluded_geo_locations: { ...(t.excluded_geo_locations ?? {}), regions: kept },
  };
}

export function makeMetaActionAdapter(client: MetaClient, retry: RetryOptions = DEFAULT_RETRY): ActionAdapter {
  // Each Graph call is individually retried + checked so a transient throttle on
  // one ad-set write doesn't abandon the rest (the merge is idempotent by key).
  const getJson = (path: string, params?: Record<string, string>): Promise<MetaResponse> =>
    withRetry(async () => check(await client.get(path, params)), retry);
  const postTargeting = (adSetId: string, targeting: MetaTargeting): Promise<MetaResponse> =>
    withRetry(async () => check(await client.post(`/${adSetId}`, { targeting: JSON.stringify(targeting) })), retry);

  // Resolve each US state in the region to Meta's numeric region key via the
  // adgeolocation targeting-search API. A state that resolves to nothing fails
  // terminally (no phantom, no silent wrong-state) rather than being skipped.
  // Match is trim + case-insensitive so a cosmetic name drift on Meta's side
  // (whitespace/case) doesn't fail the whole region; the q + US + region filters
  // keep it specific to the intended state.
  const resolveRegionKeys = async (region: RegionCode): Promise<string[]> => {
    const out: string[] = [];
    for (const name of regionStateNames(region)) {
      const body = await getJson("/search", {
        type: "adgeolocation",
        location_types: '["region"]',
        country_code: "US",
        q: name,
        limit: "50",
      });
      const results = (body.data as MetaGeoSearchResult[] | undefined) ?? [];
      const wanted = name.toLowerCase();
      const match = results.find(
        (r) =>
          r.type === "region" &&
          r.country_code === "US" &&
          typeof r.name === "string" &&
          r.name.trim().toLowerCase() === wanted,
      );
      if (!match || match.key == null) {
        throw new ActionError("meta", `could not resolve Meta region key for "${name}"`, {
          retriable: false,
        });
      }
      out.push(String(match.key));
    }
    return out;
  };

  // Geo exclusion is ad-set scoped, so fan out over the campaign's ad sets.
  const listAdSets = async (campaignId: string): Promise<MetaAdSet[]> => {
    const out: MetaAdSet[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const params: Record<string, string> = { fields: "id,targeting", limit: "200" };
      if (after) params.after = after;
      const body = await getJson(`/${campaignId}/adsets`, params);
      out.push(...((body.data as MetaAdSet[] | undefined) ?? []));
      const paging = body.paging as { cursors?: { after?: string }; next?: string } | undefined;
      if (!paging?.next || !paging.cursors?.after) break;
      after = paging.cursors.after;
    }
    return out;
  };

  return {
    platform: "meta",
    async pause(externalId) {
      await withRetry(async () => {
        check(await client.post(`/${externalId}`, { status: "PAUSED" }));
      }, retry);
    },
    async resume(externalId) {
      await withRetry(async () => {
        check(await client.post(`/${externalId}`, { status: "ACTIVE" }));
      }, retry);
    },
    async setDailyBudget(externalId, cents) {
      await withRetry(async () => {
        check(await client.post(`/${externalId}`, { daily_budget: String(cents) }));
      }, retry);
    },
    async getState(externalId): Promise<CampaignActionState> {
      const body = await withRetry(
        async () => check(await client.get(`/${externalId}`, { fields: "status,daily_budget" })),
        retry,
      );
      const raw = body as { status?: string; daily_budget?: string };
      return {
        status: (raw.status ?? "").toUpperCase() === "PAUSED" ? "paused" : "active",
        dailyBudgetCents: raw.daily_budget != null ? Number(raw.daily_budget) : null,
      };
    },
    async excludeGeo(externalId, region) {
      const keys = await resolveRegionKeys(region);
      const adSets = await listAdSets(externalId);
      if (adSets.length === 0) {
        throw new ActionError("meta", `campaign ${externalId} has no ad sets to apply geo exclusion`, {
          retriable: false,
        });
      }
      for (const adSet of adSets) {
        const current = adSet.targeting ?? {};
        const merged = mergeExcludedRegions(current, keys);
        // Idempotent: only write the ad sets the region wasn't already excluded from.
        if (excludedRegions(merged).length !== excludedRegions(current).length) {
          await postTargeting(adSet.id, merged);
        }
      }
    },
    async includeGeo(externalId, region) {
      // Undo/restore path. Unlike excludeGeo, zero ad sets is NOT an error: the
      // goal is the absence of the exclusion, which is vacuously satisfied when
      // there are no ad sets to carry it (e.g. they were deleted after exclude) —
      // re-including nothing is honest, not a phantom.
      const keys = await resolveRegionKeys(region);
      const adSets = await listAdSets(externalId);
      for (const adSet of adSets) {
        const current = adSet.targeting ?? {};
        const dropped = dropExcludedRegions(current, keys);
        if (excludedRegions(dropped).length !== excludedRegions(current).length) {
          await postTargeting(adSet.id, dropped);
        }
      }
    },
  };
}

/** Resolve a Meta action adapter for a shop, or null if not connected. */
export async function metaActionAdapterForShop(
  shopId: string,
  retry?: RetryOptions,
): Promise<ActionAdapter | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "meta_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.access_token_encrypted) return null;
  const token = decrypt(data.access_token_encrypted as string);
  const client: MetaClient = {
    async get(path, params = {}) {
      const qs = new URLSearchParams({ ...params, access_token: token }).toString();
      return (await fetch(`${GRAPH_BASE}${path}?${qs}`).then((r) => r.json())) as MetaResponse;
    },
    async post(path, body) {
      const form = new URLSearchParams({ ...body, access_token: token });
      return (await fetch(`${GRAPH_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }).then((r) => r.json())) as MetaResponse;
    },
  };
  return makeMetaActionAdapter(throttleMetaClient(client, shopId), retry);
}
