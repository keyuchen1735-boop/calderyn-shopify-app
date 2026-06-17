// ShipBob adapter (ship-cost connector — 3PL house, Phase 3 Part B). A drop-in
// ShipCostAdapter on the Phase-1 framework: the generic landing core never branches on
// provider (contract C1). Creds from integration_credentials (kind 'shipbob_ship', a
// merchant-pasted Personal Access Token with scope `billing_read`, via crypto.server.ts).
// Auth is a Bearer PAT in the Authorization header — the same API-key paste model as
// EasyPost (contract C8 / Plan 03 B.1/B.3), NOT OAuth.
//
// Reads the Billing transactions feed (POST /{ver}/transactions:query) and normalizes the
// shipping-fee `amount` → integer cents. ShipBob ties a billing transaction to a shipment
// via reference_type="Shipment" → reference_id, and carries the merchant's upstream order
// reference + tracking in the transaction's details. We map orderRef from the order
// reference when present and trackingNo from the tracking detail; matchInvoiceLines (C5)
// then resolves charge → order by ref first, tracking fallback — exactly like EasyPost.
//
// No new npm dependency (contract P6 / repo rule): built-in fetch + a Bearer header, not
// any ShipBob SDK.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../../supabase.server";
import { decrypt } from "../../crypto.server";
import type { NormalizedShipmentCost, ShipCostAdapter, ShipSource } from "./adapter";

const DEFAULT_BASE = "https://api.shipbob.com/2026-01";
const PAGE_SIZE = 100; // ShipBob PageSize max.
const MAX_PAGES = 500; // hard stop so a runaway pager can never loop forever.
// Only shipping-type fees are a per-order ship cost. ShipBob categorizes a transaction via
// a fee-type/category string; we keep rows whose category looks like a shipping/postage
// charge and skip storage/pick/pack/fuel-only lines. Matched case-insensitively, substring.
const SHIPPING_FEE_HINTS = ["shipping", "postage", "freight", "label"];

/** Shape of a ShipBob billing transaction (only the fields we read). */
export interface ShipBobTransaction {
  transaction_id?: string | number | null;
  amount?: number | string | null;
  currency_code?: string | null;
  charge_date?: string | null;
  // Fee categorization — surfaced under a few possible keys across API versions; we read
  // whichever is present to decide "is this a shipping charge".
  transaction_fee?: string | null;
  fee_type?: string | null;
  fee_category?: string | null;
  // Link-back to the shipment + upstream order.
  reference_type?: string | null;
  reference_id?: string | number | null;
  order_reference_id?: string | null;
  // Free-form details bag; tracking id commonly lives here.
  additional_details?: { tracking_id?: string | null; carrier?: string | null } | null;
  carrier?: string | null;
}

interface ShipBobQueryResponse {
  // ShipBob has used both a bare array and an envelope across versions; tolerate both.
  data?: ShipBobTransaction[];
  transactions?: ShipBobTransaction[];
  total_count?: number | null;
}

/**
 * Parse a ShipBob money value to integer cents WITHOUT float drift. ShipBob returns a
 * decimal (number or string, e.g. 7.39 / "7.39"). Returns null for missing / malformed /
 * negative so the caller can SKIP (and tally) rather than coerce a bad value to 0 (rule 12).
 */
export function parseAmountToCents(amount: number | string | null | undefined): number | null {
  if (amount == null) return null;
  const trimmed = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null; // reject NaN, signs, junk.
  const cents = Math.round(parseFloat(trimmed) * 100);
  if (!Number.isFinite(cents) || cents < 0) return null;
  return cents;
}

/** True when a transaction's fee categorization marks it a shipping/postage charge. */
function isShippingFee(t: ShipBobTransaction): boolean {
  const cat = (t.transaction_fee ?? t.fee_type ?? t.fee_category ?? "").toLowerCase();
  if (!cat) return true; // no category → assume shipping (don't silently drop a real charge).
  return SHIPPING_FEE_HINTS.some((h) => cat.includes(h));
}

/**
 * Pure mapper: one ShipBob transaction → NormalizedShipmentCost, or null to SKIP.
 * Skip when not a shipping fee, when there is no stable transaction id (can't be an
 * idempotency key), or when the amount is missing/unparseable (surfaced via tally).
 * Exported for unit testing.
 */
export function mapTransactionToNormalized(t: ShipBobTransaction): NormalizedShipmentCost | null {
  if (!isShippingFee(t)) return null;
  const externalId = t.transaction_id == null ? "" : String(t.transaction_id).trim();
  if (!externalId) return null;
  const costCents = parseAmountToCents(t.amount);
  if (costCents == null) return null; // missing/malformed amount → skip, surfaced by tally.
  const tracking = t.additional_details?.tracking_id?.trim() || null;
  return {
    externalId,
    orderRef: t.order_reference_id?.trim() || null,
    trackingNo: tracking,
    costCents,
    currency: t.currency_code?.trim() || "USD",
    shippedAt: t.charge_date ?? null,
    carrier: t.additional_details?.carrier?.trim() || t.carrier?.trim() || null,
  };
}

function apiBase(): string {
  const raw = process.env.SHIPBOB_API_BASE?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_BASE).replace(/\/+$/, "");
}

/**
 * Walk POST /{ver}/transactions:query page by page (Page/PageSize), filtering by the
 * StartDate re-pull window when `since` is given, and stopping once a page returns fewer
 * than PageSize rows (last page) or no rows. Returns normalized shipping charges only.
 */
export async function fetchShipBobCharges(
  pat: string,
  since: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedShipmentCost[]> {
  const base = apiBase();
  const out: NormalizedShipmentCost[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const body: Record<string, unknown> = { Page: page, PageSize: PAGE_SIZE };
    if (since) body.StartDate = since; // trailing re-pull window lower bound.

    const res = await fetchImpl(`${base}/transactions:query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Surface the failure so the cron records it in sync_error (rule 12). Body snippet
      // aids debugging (401 bad PAT, 403 missing billing_read scope, 429) without dumping all.
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`ShipBob ${res.status} ${res.statusText}: ${snippet}`);
    }
    const json = (await res.json()) as ShipBobQueryResponse;
    const rows = json.data ?? json.transactions ?? [];
    if (rows.length === 0) break;

    for (const t of rows) {
      const mapped = mapTransactionToNormalized(t);
      if (mapped) out.push(mapped);
    }

    if (rows.length < PAGE_SIZE) break; // short page → last page reached.
  }

  return out;
}

export const shipBobAdapter: ShipCostAdapter = {
  provider: "shipbob",
  integrationKind: "shipbob_ship",
  async connect(shopId: string): Promise<ShipSource | null> {
    const sb: SupabaseClient = getSupabase();
    const { data, error } = await sb
      .from("integration_credentials")
      .select("access_token_encrypted")
      .eq("shop_id", shopId)
      .eq("kind", "shipbob_ship")
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.access_token_encrypted) return null; // → cron marks "skipped".
    const pat = decrypt(data.access_token_encrypted as string);
    return {
      fetchCharges: (since) => fetchShipBobCharges(pat, since),
    };
  },
};
