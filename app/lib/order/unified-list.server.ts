// Thin TypeScript wrapper over the unified-list SQL function. Maps browser-safe
// params → RPC args (snake_case, nulls as defaults) and rows → UnifiedOrderRow.
// Server-only; reaches Postgres via getSupabase().rpc().

import { getSupabase } from "~/lib/supabase.server";
import type { OrdersListParams, UnifiedOrderRow, UnifiedOrdersPage } from "./unified-list-types";

/** Escape ILIKE metacharacters in free-text search before it reaches the RPC, so a merchant
 *  literally searching for e.g. "50% off" or "rush_order" gets that text matched exactly instead
 *  of `%`/`_` being treated as SQL wildcards. Backslash must be escaped FIRST — escaping it after
 *  `%`/`_` would double-escape the backslashes those two replacements just inserted. Postgres's
 *  default LIKE/ILIKE escape character is backslash, matching this order. */
export function escapeLikeMetacharacters(search: string): string {
  return search.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function listOrdersUnified(shopId: string, params: OrdersListParams): Promise<UnifiedOrdersPage> {
  if (!shopId) throw new Error("shopId is required");

  // Mirror the SQL function's clamping: offset ≥ 0, limit ∈ [1, 1000]
  const appliedOffset = Math.max(params.offset ?? 0, 0);
  const appliedLimit = Math.min(Math.max(params.limit ?? 50, 1), 1000);

  const { data, error } = await getSupabase().rpc("list_orders_unified", {
    p_shop_id: shopId,
    p_search: params.search ? escapeLikeMetacharacters(params.search) : null,
    p_payment_status: params.paymentStatus ?? null,
    p_fulfillment_status: params.fulfillmentStatus ?? null,
    p_source: params.source ?? null,
    p_date_from: params.dateFrom ?? null,
    p_date_to: params.dateTo ?? null,
    p_tag: params.tag ?? null,
    p_archived: params.archived ?? false,
    p_sort: params.sort ?? "date",
    p_dir: params.dir ?? "desc",
    p_offset: appliedOffset,
    p_limit: appliedLimit,
  });

  if (error) throw error;

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const totalCount = rows.length > 0 ? Number(rows[0].full_count) : 0;

  return {
    rows: rows.map((row) => mapRow(row)),
    totalCount,
    offset: appliedOffset,
    limit: appliedLimit,
  };
}

function mapRow(row: Record<string, unknown>): UnifiedOrderRow {
  return {
    source: String(row.source) as "calderyn" | "shopify",
    id: String(row.id),
    ref: String(row.ref),
    buyerEmail: row.buyer_email == null ? null : String(row.buyer_email),
    totalCents: Number(row.total_cents),
    currency: String(row.currency),
    paymentStatus: String(row.payment_status),
    state: String(row.state),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    occurredAt: String(row.occurred_at),
    itemCount: Number(row.item_count),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    remainingRefundableCents: Number(row.remaining_refundable_cents),
  };
}
