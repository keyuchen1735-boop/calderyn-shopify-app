// Shippo adapter (ship-cost connector #2). Creds from integration_credentials
// (kind 'shippo_ship', an OAuth access token via crypto.server.ts). Auth is
// `Authorization: Bearer oauth.<token>` — the stored token value already begins with
// `oauth.`; Shippo's `ShippoToken` scheme does NOT work for OAuth tokens (Plan 02 §5.3).
// Reads GET /transactions/?object_status=SUCCESS and normalizes rate.amount → cents.
//
// No new npm dependency (contract P6 / repo rule): the built-in fetch, not the
// shippo SDK.
//
// Source of truth: Shippo OpenAPI spec 2018-02-08 (Transaction / CoreRate /
// TransactionStatusEnum). Two load-bearing facts (Plan 02 §4.4):
//   1. amounts are JSON STRINGS ("5.52") → parse to integer cents without float drift;
//   2. Transaction.rate is oneOf { CoreRate object | string id } — on LIST responses
//      it frequently comes back as a bare rate-id string, in which case the cost is
//      NOT inline and we must GET /transactions/{id} to obtain the nested CoreRate.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../../supabase.server";
import { decrypt } from "../../crypto.server";
import type { NormalizedShipmentCost, ShipCostAdapter, ShipSource } from "./adapter";

const DEFAULT_BASE = "https://api.goshippo.com";
const API_VERSION = "2018-02-08"; // Shippo-API-Version pinned to the spec we built against.
const PAGE_SIZE = 100; // Shippo `results` hard cap (spec maximum:100). DO NOT send 200 (Plan 02 concern #2).
const MAX_PAGES = 500; // hard stop so a runaway `next` can never loop forever.

/** Shippo CoreRate sub-object (only the fields we read). */
interface ShippoRate {
  amount?: string | null; // ACTUAL paid amount, decimal STRING e.g. "5.52".
  currency?: string | null;
  provider?: string | null; // carrier name, e.g. "USPS".
}

/**
 * Shippo Transaction (only the fields we read). `rate` is oneOf { CoreRate | string }
 * per the spec, so it is typed as the union here and narrowed in the mapper (§4.4).
 */
export interface ShippoTransaction {
  object_id?: string | null;
  object_created?: string | null;
  status?: string | null; // response field is `status`; the LIST filter param is `object_status`.
  metadata?: string | null; // the ONLY order match-back hook (≤100 chars), may be blank/arbitrary.
  tracking_number?: string | null;
  rate?: ShippoRate | string | null;
}

interface ShippoListResponse {
  results?: ShippoTransaction[];
  next?: string | null;
  previous?: string | null;
}

function bearerAuthHeader(token: string): string {
  // The stored token already begins with "oauth." (Shippo OAuth access token form).
  return `Bearer ${token}`;
}

/**
 * Parse a Shippo money string ("5.52") to integer cents WITHOUT float drift.
 * Returns null for missing / malformed / negative values so the caller can SURFACE
 * (and tally) the row rather than silently landing NaN/0 (rule 12, Plan 02 §4.4/§10).
 */
export function parseAmountToCents(amount: string | null | undefined): number | null {
  if (amount == null) return null;
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null; // reject NaN, signs, junk.
  const cents = Math.round(parseFloat(trimmed) * 100);
  if (!Number.isFinite(cents) || cents < 0) return null;
  return cents;
}

/** Narrowing guard: is the Transaction.rate the nested CoreRate object (vs a bare id)? */
function isRateObject(rate: ShippoTransaction["rate"]): rate is ShippoRate {
  return typeof rate === "object" && rate !== null;
}

/**
 * Pure mapper: one Shippo Transaction (with its rate ALREADY resolved to the nested
 * CoreRate object) → NormalizedShipmentCost, or null to SURFACE-as-unmappable. Skip
 * when the status is not SUCCESS, the rate/amount is missing/unparseable, or there is
 * no stable object_id (can't be an idempotency key). The `rate` oneOf resolution
 * (object vs id→fetch) happens upstream in fetchShippoCharges; this mapper assumes a
 * resolved rate object so it stays pure + unit-testable. Exported for tests.
 */
export function mapTransactionToNormalized(t: ShippoTransaction): NormalizedShipmentCost | null {
  const externalId = t.object_id?.trim();
  if (!externalId) return null;
  // Defensive re-check (Plan 02 §4.2): only landed SUCCESS labels are costs, even if
  // the API echoed a non-SUCCESS row despite ?object_status=SUCCESS.
  if (t.status != null && t.status !== "SUCCESS") return null;
  if (!isRateObject(t.rate)) return null; // unresolved id string → unmappable, not cost 0.
  const costCents = parseAmountToCents(t.rate.amount);
  if (costCents == null) return null; // malformed/absent amount → surfaced via tally.
  return {
    externalId,
    orderRef: t.metadata?.trim() || null,
    trackingNo: t.tracking_number?.trim() || null,
    costCents,
    currency: t.rate.currency?.trim() || "USD",
    shippedAt: t.object_created ?? null,
    carrier: t.rate.provider?.trim() || null,
  };
}

function apiBase(): string {
  // Optional override for testing against a mock; default to production.
  const raw = process.env.SHIPPO_API_BASE?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_BASE).replace(/\/+$/, "");
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    Authorization: bearerAuthHeader(token),
    "Shippo-API-Version": API_VERSION,
    Accept: "application/json",
  };
}

/**
 * Resolve the `rate` oneOf for a single Transaction (Plan 02 §4.4). If the list row
 * already carries the nested CoreRate object, return the row untouched. If `rate` is a
 * bare id string (the common list-response case), fetch GET /transactions/{object_id}
 * to obtain the nested CoreRate and return a row with `rate` replaced by that object.
 * On any failure to obtain a usable rate object, return the row unchanged (its `rate`
 * stays a string) so the mapper surfaces it as unmappable rather than landing cost 0.
 */
async function resolveRate(
  t: ShippoTransaction,
  base: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ShippoTransaction> {
  if (isRateObject(t.rate)) return t; // already inline.
  const id = t.object_id?.trim();
  if (!id) return t; // no id → can't fetch detail; mapper will surface as unmappable.

  const url = new URL(`${base}/transactions/${encodeURIComponent(id)}`);
  const res = await fetchImpl(url.toString(), { method: "GET", headers: jsonHeaders(token) });
  if (!res.ok) {
    // Surface the failure so the cron records it in sync_error (rule 12). Body snippet
    // aids debugging (401 bad token, 429 rate limit, …) without dumping the whole body.
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Shippo ${res.status} ${res.statusText} (GET /transactions/${id}): ${body}`);
  }
  const detail = (await res.json()) as ShippoTransaction;
  if (isRateObject(detail.rate)) {
    // Keep the list row's fields, swap in the resolved nested rate object.
    return { ...t, rate: detail.rate };
  }
  return t; // detail still lacked a nested rate → unmappable downstream.
}

/**
 * Walk GET /transactions/?object_status=SUCCESS&results=100 via the envelope `next`
 * URL (Plan 02 §6). There is no `count` field, so we loop on `next` until null. `since`
 * (the trailing re-pull window from C3) is applied as a CLIENT-SIDE cutoff: the spec
 * does not document a server-side date filter on /transactions, so we stop once a row's
 * object_created predates `since` (transactions list newest-first). For each SUCCESS
 * row we resolve the `rate` oneOf (object inline, else fetch detail) then map (§4).
 * Returns normalized, SUCCESS-only charges with a resolvable cost.
 */
export async function fetchShippoCharges(
  token: string,
  since: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedShipmentCost[]> {
  const base = apiBase();
  const sinceMs = since ? Date.parse(since) : NaN;
  const haveSince = Number.isFinite(sinceMs);

  const out: NormalizedShipmentCost[] = [];

  // First page: the canonical filtered URL. Subsequent pages follow the `next` link
  // verbatim (it already carries object_status/results/page).
  const first = new URL(`${base}/transactions/`);
  first.searchParams.set("object_status", "SUCCESS");
  first.searchParams.set("results", String(PAGE_SIZE));
  let nextUrl: string | null = first.toString();

  for (let page = 0; page < MAX_PAGES && nextUrl; page++) {
    const res = await fetchImpl(nextUrl, { method: "GET", headers: jsonHeaders(token) });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Shippo ${res.status} ${res.statusText}: ${body}`);
    }
    const json = (await res.json()) as ShippoListResponse;
    const rows = json.results ?? [];
    if (rows.length === 0) break;

    let crossedWindow = false;
    for (const t of rows) {
      if (t.status != null && t.status !== "SUCCESS") continue; // defensive status filter (§4.2).
      if (haveSince && t.object_created) {
        const ts = Date.parse(t.object_created);
        if (Number.isFinite(ts) && ts < sinceMs) {
          crossedWindow = true;
          continue; // older than the re-pull window → don't emit; finish the page then stop.
        }
      }
      const resolved = await resolveRate(t, base, token, fetchImpl);
      const mapped = mapTransactionToNormalized(resolved);
      if (mapped) out.push(mapped);
    }

    if (crossedWindow) break; // reached the trailing-window floor.
    nextUrl = json.next ?? null; // follow the envelope; null → done (no count field to rely on).
  }

  return out;
}

export const shippoAdapter: ShipCostAdapter = {
  provider: "shippo",
  integrationKind: "shippo_ship",
  async connect(shopId: string): Promise<ShipSource | null> {
    const sb: SupabaseClient = getSupabase();
    const { data, error } = await sb
      .from("integration_credentials")
      .select("access_token_encrypted")
      .eq("shop_id", shopId)
      .eq("kind", "shippo_ship")
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.access_token_encrypted) return null; // → cron marks "skipped".
    const token = decrypt(data.access_token_encrypted as string);
    return {
      fetchCharges: (since) => fetchShippoCharges(token, since),
    };
  },
};
