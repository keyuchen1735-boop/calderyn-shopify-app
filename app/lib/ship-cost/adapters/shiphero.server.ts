// ShipHero adapter (ship-cost connector — 3PL house, Phase 3 Part B). A drop-in
// ShipCostAdapter on the Phase-1 framework: the generic landing core never branches on
// provider (contract C1). ShipHero is CREDENTIAL/TOKEN-BASED, NOT OAuth: the merchant
// creates a dedicated "3rd Party Developer" user in ShipHero and is issued an access token
// (28-day) + a long-lived REFRESH token — there is no authorize-redirect and no app
// client_id/secret. We store the merchant's REFRESH token encrypted in
// integration_credentials (kind 'shiphero_ship', access_token_encrypted, via
// crypto.server.ts — the QuickBooks refresh-token storage model). connect() mints a fresh
// access token from it each run via /auth/refresh (auth.server.ts); GraphQL auth is then a
// Bearer <access_token> (contract C8 / Plan 03 B.2/B.3, corrected — credential/refresh, not
// OAuth, and not a directly-usable pasted key).
//
// ⚠️ LIVE-VERIFICATION TODO (d): we refresh EAGERLY each run (mint a fresh access token at
// connect() time) rather than caching an access token and refreshing on a 401. With a daily
// cron and 28-day access tokens this is the simplest correct choice; if call volume grows,
// switch to cache-token + refresh-on-401.
//
// Reads the GraphQL `shipments` connection → `shipping_labels { cost }` per label (the
// actual label cost) and normalizes each label → integer cents. Match-back is STRONG:
// shipment → order.partner_order_id (the upstream Shopify order id), fallback order_number;
// plus shipping_labels.tracking_number. matchInvoiceLines (C5) resolves ref-first,
// tracking-fallback — same as every other adapter.
//
// ⚠️ ZERO-COST CAVEAT / LIVE-VERIFICATION TODO (c) (contract §8.4 / Plan 03 B.2, risk #4): a
// community-reported ShipHero config can report a label `cost` of 0 (or null). A 0-cost label
// is NOT a true per-order cost — emitting it would land a bogus actual_invoice/high signal
// that wrongly zeroes the order's ship cost. So a label whose cost parses to null OR 0 is
// SKIPPED here (already guarded in parseLabelCostToCents — and tallied by the landing layer as
// skipped-no-key when nothing else carries it), never emitted as an actual cost. Whether a
// given onboarded account actually populates a non-zero `cost` is confirmed per account; the
// guard makes the failure mode safe (skip), not silently wrong, until then.
//
// No new npm dependency (contract P6 / repo rule): built-in fetch + a Bearer header.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../../supabase.server";
import { decrypt } from "../../crypto.server";
import { refreshShipHeroToken } from "../../shiphero/auth.server";
import type { NormalizedShipmentCost, ShipCostAdapter, ShipSource } from "./adapter";

const DEFAULT_BASE = "https://public-api.shiphero.com/graphql";
const PAGE_SIZE = 100; // conservative page size — ShipHero throttles heavy queries by credits.
const MAX_PAGES = 500; // hard stop so a runaway cursor can never loop forever.

// GraphQL document: shipments since a date, with each shipment's order refs + labels.
// `date_from` filters server-side to the re-pull window. Cursor pagination via pageInfo.
const SHIPMENTS_QUERY = `
query ShipmentsForCost($dateFrom: ISODateTime, $first: Int!, $after: String) {
  shipments(date_from: $dateFrom) {
    data(first: $first, after: $after) {
      edges {
        node {
          id
          created_date
          order { partner_order_id order_number }
          shipping_labels { cost tracking_number carrier }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

interface ShipHeroLabel {
  cost?: number | string | null;
  tracking_number?: string | null;
  carrier?: string | null;
}
interface ShipHeroShipmentNode {
  id?: string | null;
  created_date?: string | null;
  order?: { partner_order_id?: string | null; order_number?: string | null } | null;
  shipping_labels?: ShipHeroLabel[] | null;
}
interface ShipHeroEdge {
  node?: ShipHeroShipmentNode | null;
}
interface ShipHeroResponse {
  data?: {
    shipments?: {
      data?: {
        edges?: ShipHeroEdge[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      } | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string }>;
}

/**
 * Parse a ShipHero label cost to integer cents WITHOUT float drift. Returns null for
 * missing / malformed / negative / ZERO. Zero is treated as "no usable cost" on purpose
 * (the zero-cost caveat above): a 0 label cost must never become an actual_invoice signal.
 * Exported for unit testing.
 */
export function parseLabelCostToCents(cost: number | string | null | undefined): number | null {
  if (cost == null) return null;
  const trimmed = String(cost).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null; // reject NaN, signs, junk.
  const cents = Math.round(parseFloat(trimmed) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return null; // <= 0 → skip (zero-cost guard).
  return cents;
}

/**
 * Pure mapper: one ShipHero (shipment, label) pair → NormalizedShipmentCost, or null to
 * SKIP. Skip when the label cost is missing/zero (guard) or there is no stable id for the
 * idempotency key. externalId = "<shipmentId>:<labelIndex>" so multiple labels on one
 * shipment stay distinct and land as distinct lines (the resolver sums them per order).
 * Exported for unit testing.
 */
export function mapLabelToNormalized(
  shipment: ShipHeroShipmentNode,
  label: ShipHeroLabel,
  labelIndex: number,
): NormalizedShipmentCost | null {
  const costCents = parseLabelCostToCents(label.cost);
  if (costCents == null) return null; // missing/zero cost → skip (zero-cost guard, surfaced).
  const shipmentId = shipment.id?.trim();
  if (!shipmentId) return null; // no stable id → can't key idempotency.
  // partner_order_id is the upstream Shopify order id; ShipHero may store it as a GraphQL
  // GID ("gid://shopify/Order/1001"). order_fact.order_number is the numeric name ("#1001"),
  // and matchInvoiceLines strips a leading '#' before comparing — so a raw GID would never
  // ref-match. Extract the trailing numeric id from a GID; pass any other value through.
  const pid = shipment.order?.partner_order_id?.trim();
  const partnerRef = pid ? (pid.startsWith("gid://") ? (pid.split("/").pop() ?? pid) : pid) : null;
  const orderRef = partnerRef || shipment.order?.order_number?.trim() || null;
  return {
    externalId: `${shipmentId}:${labelIndex}`,
    orderRef,
    trackingNo: label.tracking_number?.trim() || null,
    costCents,
    currency: "USD", // ShipHero account currency; not on the label — default to USD.
    shippedAt: shipment.created_date ?? null,
    carrier: label.carrier?.trim() || null,
  };
}

function apiBase(): string {
  const raw = process.env.SHIPHERO_API_BASE?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_BASE).replace(/\/+$/, "");
}

/**
 * Walk the GraphQL `shipments` connection via cursor pagination, emitting one normalized
 * row per (shipment, non-zero label). `since` becomes `date_from`. Stops when hasNextPage
 * is false or the page is empty.
 */
export async function fetchShipHeroCharges(
  accessToken: string,
  since: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedShipmentCost[]> {
  const base = apiBase();
  const out: NormalizedShipmentCost[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(base, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: SHIPMENTS_QUERY,
        variables: { dateFrom: since, first: PAGE_SIZE, after },
      }),
    });
    if (!res.ok) {
      // Surface the failure so the cron records it in sync_error (rule 12).
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`ShipHero ${res.status} ${res.statusText}: ${snippet}`);
    }
    const json = (await res.json()) as ShipHeroResponse;
    if (json.errors && json.errors.length > 0) {
      // GraphQL returns 200 with an errors array — surface it, don't silently emit nothing.
      throw new Error(`ShipHero GraphQL error: ${json.errors.map((e) => e.message ?? "?").join("; ").slice(0, 200)}`);
    }
    const conn = json.data?.shipments?.data;
    const edges = conn?.edges ?? [];
    if (edges.length === 0) break;

    for (const edge of edges) {
      const node = edge.node;
      if (!node) continue;
      const labels = node.shipping_labels ?? [];
      labels.forEach((label, i) => {
        const mapped = mapLabelToNormalized(node, label, i);
        if (mapped) out.push(mapped);
      });
    }

    if (conn?.pageInfo?.hasNextPage !== true) break;
    const next = conn?.pageInfo?.endCursor ?? null;
    if (!next || next === after) break; // no forward progress → stop.
    after = next;
  }

  return out;
}

export const shipHeroAdapter: ShipCostAdapter = {
  provider: "shiphero",
  integrationKind: "shiphero_ship",
  async connect(shopId: string): Promise<ShipSource | null> {
    const sb: SupabaseClient = getSupabase();
    const { data, error } = await sb
      .from("integration_credentials")
      .select("access_token_encrypted")
      .eq("shop_id", shopId)
      .eq("kind", "shiphero_ship")
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.access_token_encrypted) return null; // → cron marks "skipped" (genuinely no creds).
    // The stored value is the merchant's long-lived REFRESH token (not a directly-usable
    // access token). A credential IS stored, so this shop is connected — mint a fresh access
    // token from it each run. If the refresh FAILS (the refresh token was revoked/expired, or
    // ShipHero is down), the connection is BROKEN, not absent: let the error PROPAGATE so the
    // cron records sync_status:'error' (failure-visibility, rule 12) — same as a fetchCharges
    // 401 for the other adapters — rather than masquerading as a benign "not connected" skip.
    // (null is reserved for genuinely-absent creds, above.) refreshShipHeroToken never logs
    // the token, so the propagated error does not surface the refresh-token value.
    const refreshToken = decrypt(data.access_token_encrypted as string);
    const { accessToken } = await refreshShipHeroToken(refreshToken);
    return {
      fetchCharges: (since) => fetchShipHeroCharges(accessToken, since),
    };
  },
};
