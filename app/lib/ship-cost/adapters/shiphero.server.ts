// ShipHero adapter (ship-cost connector — 3PL house, Phase 3 Part B). A drop-in
// ShipCostAdapter on the Phase-1 framework: the generic landing core never branches on
// provider (contract C1). Creds from integration_credentials (kind 'shiphero_ship', a
// per-merchant OAuth 2.0 access token, via crypto.server.ts). Auth is a Bearer token
// against the GraphQL endpoint (contract C8 / Plan 03 B.2/B.3, like Shippo — OAuth, NOT a
// pasted API key).
//
// Reads the GraphQL `shipments` connection → `shipping_labels { cost }` per label (the
// actual label cost) and normalizes each label → integer cents. Match-back is STRONG:
// shipment → order.partner_order_id (the upstream Shopify order id), fallback order_number;
// plus shipping_labels.tracking_number. matchInvoiceLines (C5) resolves ref-first,
// tracking-fallback — same as every other adapter.
//
// ⚠️ ZERO-COST CAVEAT (contract §8.4 / Plan 03 B.2, risk #4): a community-reported ShipHero
// config can report a label `cost` of 0 (or null). A 0-cost label is NOT a true per-order
// cost — emitting it would land a bogus actual_invoice/high signal that wrongly zeroes the
// order's ship cost. So a label whose cost parses to null OR 0 is SKIPPED here (and tallied
// by the landing layer as skipped-no-key when nothing else carries it), never emitted as an
// actual cost. Real cost confirmation per onboarded account gates the actual_invoice claim.
//
// No new npm dependency (contract P6 / repo rule): built-in fetch + a Bearer header.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../../supabase.server";
import { decrypt } from "../../crypto.server";
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
 * shipment stay distinct and the pre-aggregation (C4.3) sums them per order. Exported for
 * unit testing.
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
  const orderRef =
    shipment.order?.partner_order_id?.trim() || shipment.order?.order_number?.trim() || null;
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
    if (!data || !data.access_token_encrypted) return null; // → cron marks "skipped".
    const accessToken = decrypt(data.access_token_encrypted as string);
    return {
      fetchCharges: (since) => fetchShipHeroCharges(accessToken, since),
    };
  },
};
