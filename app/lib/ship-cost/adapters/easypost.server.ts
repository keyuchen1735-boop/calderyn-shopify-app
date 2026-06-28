// EasyPost adapter (ship-cost connector #1). Creds from integration_credentials
// (kind 'easypost_ship', text API key via crypto.server.ts). Auth is HTTP Basic with
// the API key as username and empty password — NOT Bearer (docs.easypost.com).
// Reads GET /v2/shipments?purchased=true and normalizes selected_rate.rate → cents.
//
// No new npm dependency (contract P6 / repo rule): the built-in fetch + HTTP Basic,
// not the @easypost/api SDK.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../../supabase.server";
import { decrypt } from "../../crypto.server";
import type { NormalizedShipmentCost, ShipCostAdapter, ShipSource } from "./adapter";

const DEFAULT_BASE = "https://api.easypost.com/v2";
const PAGE_SIZE = 100; // EasyPost max per page.
const MAX_PAGES = 500; // hard stop so a runaway cursor can never loop forever.

/** Shape of the EasyPost `selected_rate` sub-object (only the fields we read). */
interface EasyPostRate {
  rate?: string | null; // ACTUAL paid amount, decimal STRING e.g. "7.39".
  currency?: string | null;
  carrier?: string | null;
}

/** Shape of an EasyPost Shipment (only the fields we read). */
export interface EasyPostShipment {
  id?: string | null;
  reference?: string | null;
  tracking_code?: string | null;
  created_at?: string | null;
  selected_rate?: EasyPostRate | null;
}

interface EasyPostListResponse {
  shipments?: EasyPostShipment[];
  has_more?: boolean;
}

export function basicAuthHeader(apiKey: string): string {
  // EasyPost: key as username, empty password → base64("KEY:").
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

/**
 * Parse an EasyPost money string ("7.39") to integer cents WITHOUT float drift.
 * Returns null for missing / malformed / negative values so the caller can SKIP
 * (and tally) the shipment rather than silently coercing a bad rate to 0 (rule 12).
 */
export function parseRateToCents(rate: string | null | undefined): number | null {
  if (rate == null) return null;
  const trimmed = String(rate).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null; // reject NaN, signs, junk.
  const cents = Math.round(parseFloat(trimmed) * 100);
  if (!Number.isFinite(cents) || cents < 0) return null;
  return cents;
}

/**
 * Pure mapper: one EasyPost Shipment → NormalizedShipmentCost, or null to SKIP.
 * Skip when there is no purchased rate (no selected_rate / unparseable rate) or no
 * stable shipment id (can't be an idempotency key). Exported for unit testing.
 */
export function mapShipmentToNormalized(s: EasyPostShipment): NormalizedShipmentCost | null {
  const externalId = s.id?.trim();
  if (!externalId) return null;
  const rate = s.selected_rate;
  if (!rate) return null; // created but no rate bought → not an actual cost.
  const costCents = parseRateToCents(rate.rate);
  if (costCents == null) return null; // malformed/absent rate → skip (surfaced via tally).
  return {
    externalId,
    orderRef: s.reference?.trim() || null,
    trackingNo: s.tracking_code?.trim() || null,
    costCents,
    currency: (rate.currency?.trim() || "USD"),
    shippedAt: s.created_at ?? null,
    carrier: rate.carrier?.trim() || null,
  };
}

export function apiBase(): string {
  // Optional override (contract P5); default to production v2.
  const raw = process.env.EASYPOST_API_BASE?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_BASE).replace(/\/+$/, "");
}

/**
 * Walk GET /v2/shipments?purchased=true newest→oldest via the `before_id` cursor,
 * stopping once a page's oldest shipment predates `since` (the re-pull window bound)
 * or `has_more` is false. Returns normalized, purchased-rate charges only.
 */
export async function fetchEasyPostCharges(
  apiKey: string,
  since: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedShipmentCost[]> {
  const base = apiBase();
  const auth = basicAuthHeader(apiKey);
  const sinceMs = since ? Date.parse(since) : NaN;
  const haveSince = Number.isFinite(sinceMs);

  const out: NormalizedShipmentCost[] = [];
  let beforeId: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${base}/shipments`);
    url.searchParams.set("purchased", "true");
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (beforeId) url.searchParams.set("before_id", beforeId);

    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: auth, Accept: "application/json" },
    });
    if (!res.ok) {
      // Surface the failure so the cron records it in sync_error (rule 12). Body
      // snippet aids debugging (401 bad key, 429 rate limit, …) without dumping all.
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`EasyPost ${res.status} ${res.statusText}: ${body}`);
    }
    const json = (await res.json()) as EasyPostListResponse;
    const shipments = json.shipments ?? [];
    if (shipments.length === 0) break;

    let crossedWindow = false;
    for (const s of shipments) {
      if (haveSince && s.created_at) {
        const t = Date.parse(s.created_at);
        if (Number.isFinite(t) && t < sinceMs) {
          crossedWindow = true;
          continue; // older than the window → don't emit; finish the page then stop.
        }
      }
      const mapped = mapShipmentToNormalized(s);
      if (mapped) out.push(mapped);
    }

    if (crossedWindow) break; // reached the trailing-window floor.
    if (json.has_more !== true) break;
    // Next cursor = the true page TAIL's id. EasyPost lists newest-first, so the last
    // element is the oldest, and before_id is EXCLUSIVE (no overlap). Use the raw tail
    // id, not "last shipment that happened to have an id" — anchoring the cursor on a
    // non-tail row would re-request an overlapping range and double-emit charges.
    const tailId = shipments[shipments.length - 1]?.id ?? null;
    if (!tailId || tailId === beforeId) break; // no forward progress → stop.
    beforeId = tailId;
  }

  return out;
}

export const easyPostAdapter: ShipCostAdapter = {
  provider: "easypost",
  integrationKind: "easypost_ship",
  async connect(shopId: string): Promise<ShipSource | null> {
    const sb: SupabaseClient = getSupabase();
    const { data, error } = await sb
      .from("integration_credentials")
      .select("access_token_encrypted")
      .eq("shop_id", shopId)
      .eq("kind", "easypost_ship")
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.access_token_encrypted) return null; // → cron marks "skipped".
    const apiKey = decrypt(data.access_token_encrypted as string);
    return {
      fetchCharges: (since) => fetchEasyPostCharges(apiKey, since),
    };
  },
};
