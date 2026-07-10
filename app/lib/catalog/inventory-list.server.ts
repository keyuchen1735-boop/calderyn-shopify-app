// Shop-wide inventory list read: thin wrapper over the inventory_list SQL
// function (one row per tracked variant with balance rollups + windowed total),
// plus the restock-presence decorator that surfaces Autopilot's recent
// create_po_draft activity next to the matching low/out rows.
import { getSupabase } from "../supabase.server";

/** Wire shape of one inventory_list RPC row (snake_case, straight from SQL). */
interface InventoryListRpcRow {
  variant_id: string;
  product_id: string;
  sku: string | null;
  variant_title: string | null;
  product_title: string;
  on_hand: number;
  reserved: number;
  incoming: number;
  available: number;
  low: boolean;
  location_count: number;
  single_location_id: string | null;
  total_count: number;
}

export interface RestockPresence {
  auditId: string;
  createdAt: string;
  outcome: string;
}

export interface InventoryRow {
  variantId: string;
  productId: string;
  sku: string | null;
  variantTitle: string | null;
  productTitle: string;
  onHand: number;
  reserved: number;
  incoming: number;
  available: number;
  low: boolean;
  locationCount: number;
  singleLocationId: string | null;
  restock: RestockPresence | null;
}

/** Map one snake_case RPC row to the camelCase row the API serves. Pure and
 *  exported so the mapping is unit-testable without a database. */
export function mapInventoryRow(raw: InventoryListRpcRow): InventoryRow {
  return {
    variantId: raw.variant_id,
    productId: raw.product_id,
    sku: raw.sku,
    variantTitle: raw.variant_title,
    productTitle: raw.product_title,
    onHand: raw.on_hand,
    reserved: raw.reserved,
    incoming: raw.incoming,
    available: raw.available,
    low: raw.low,
    locationCount: raw.location_count,
    singleLocationId: raw.single_location_id,
    restock: null,
  };
}

/** Backslash-escape LIKE/ILIKE metacharacters (\, %, _) so a merchant's search
 *  term matches literally instead of acting as a wildcard. Pure and exported
 *  for unit tests and for other catalog search sites. */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function listInventory(
  shopId: string,
  opts: { search?: string; stock?: "low" | "out"; limit?: number; offset?: number } = {},
): Promise<{ rows: InventoryRow[]; total: number }> {
  const { data, error } = await getSupabase().rpc("inventory_list", {
    p_shop_id: shopId,
    p_search: opts.search == null ? null : escapeLike(opts.search),
    p_stock: opts.stock ?? null,
    p_limit: Math.min(opts.limit ?? 50, 100),
    p_offset: Math.max(0, opts.offset ?? 0),
  });
  if (error) throw error;
  const raw = (data ?? []) as InventoryListRpcRow[];
  return {
    rows: raw.map(mapInventoryRow),
    total: raw.length ? Number(raw[0].total_count) : 0,
  };
}

/** The sku a create_po_draft audit row restocks: the first PO line's sku from
 *  the params snapshot, or null when the snapshot is absent or malformed. Pure
 *  and exported for unit tests. */
export function restockKeyFromParams(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const po = (params as Record<string, unknown>).po;
  if (typeof po !== "object" || po === null) return null;
  const lines = (po as Record<string, unknown>).lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const first = lines[0];
  if (typeof first !== "object" || first === null) return null;
  const sku = (first as Record<string, unknown>).sku;
  return typeof sku === "string" && sku ? sku : null;
}

const RESTOCK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Decorate inventory rows with the latest ≤30-day create_po_draft audit entry
 * whose PO snapshot targets the row's sku, so the Inventory screen can show
 * "Restock draft" presence without a per-row query. Returns new row objects;
 * rows without a matching draft keep `restock: null`.
 */
export async function attachRestockPresence(shopId: string, rows: InventoryRow[]): Promise<InventoryRow[]> {
  if (rows.length === 0) return rows;
  const cutoff = new Date(Date.now() - RESTOCK_WINDOW_MS).toISOString();
  const { data, error } = await getSupabase()
    .from("action_audit")
    .select("id, params, outcome, created_at")
    .eq("shop_id", shopId)
    .eq("action_kind", "create_po_draft")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;

  // Newest-first order + "keep first seen" = each sku maps to its latest draft.
  const bySku = new Map<string, RestockPresence>();
  for (const entry of data ?? []) {
    const sku = restockKeyFromParams(entry.params);
    if (!sku || bySku.has(sku)) continue;
    bySku.set(sku, {
      auditId: String(entry.id),
      createdAt: String(entry.created_at),
      outcome: String(entry.outcome),
    });
  }
  if (bySku.size === 0) return rows;

  return rows.map((row) => {
    const restock = row.sku ? bySku.get(row.sku) ?? null : null;
    return restock ? { ...row, restock } : row;
  });
}
