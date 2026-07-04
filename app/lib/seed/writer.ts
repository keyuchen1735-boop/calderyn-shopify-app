// app/lib/seed/writer.ts
//
// Persist a generated SeedDataset into Supabase: wipe the shop's existing
// rows (children → parents), then insert the new dataset (parents →
// children) in PostgREST-sized batches. Any error aborts immediately —
// a partial seed must never look like a finished one (rule 12).

import type { SeedDataset } from "./dataset";

/** Minimal client surface so tests can fake it; supabase-js satisfies it. */
export interface SeedWriterClient {
  from(table: string): {
    delete(): { eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }> };
    insert(rows: Record<string, unknown>[]): PromiseLike<{ error: { message: string } | null }>;
  };
}

const BATCH_SIZE = 500;

/** Delete order: every FK child before its parent. Includes engine-written
 * alert tables and action history so a reseed resets the whole demo story. */
export const WIPE_ORDER = [
  "action_idempotency",
  "action_audit",
  "alert_context",
  "alerts",
  "ad_click_ref", // references order_fact
  "attribution_fact", // references order_fact + ad_campaign_dim
  "ad_engagement_fact",
  "campaign_grade_fact",
  "ad_spend_fact",
  "ad_creative_sku_map",
  "ad_campaign_dim",
  "sku_pnl",
  "sku_velocity",
  "stockout_forecast",
  "cogs_fact",
  "inventory_level_fact",
  "refund_fact", // references order_fact + sku_dim
  "order_line_fact",
  "fulfillment_fact",
  "order_fact",
  "sku_dim",
  "location_dim",
] as const;

/** Insert order: parents before children. */
export const INSERT_ORDER = [
  "location_dim",
  "sku_dim",
  "cogs_fact",
  "order_fact",
  "order_line_fact",
  "refund_fact",
  "fulfillment_fact",
  "ad_campaign_dim",
  "ad_spend_fact",
  "ad_engagement_fact",
  "ad_creative_sku_map",
  "campaign_grade_fact",
  "attribution_fact",
  "inventory_level_fact",
  "sku_pnl",
  "sku_velocity",
  "stockout_forecast",
] as const;

function rowsFor(ds: SeedDataset, table: (typeof INSERT_ORDER)[number]): Record<string, unknown>[] {
  switch (table) {
    case "location_dim": return ds.locations as unknown as Record<string, unknown>[];
    case "sku_dim": return ds.skus as unknown as Record<string, unknown>[];
    case "cogs_fact": return ds.cogsFacts as unknown as Record<string, unknown>[];
    case "order_fact": return ds.orders as unknown as Record<string, unknown>[];
    case "order_line_fact": return ds.orderLines as unknown as Record<string, unknown>[];
    case "refund_fact": return ds.refunds as unknown as Record<string, unknown>[];
    case "fulfillment_fact": return ds.fulfillments as unknown as Record<string, unknown>[];
    case "ad_campaign_dim": return ds.campaigns as unknown as Record<string, unknown>[];
    case "ad_spend_fact": return ds.adSpend as unknown as Record<string, unknown>[];
    case "ad_engagement_fact": return ds.adEngagement as unknown as Record<string, unknown>[];
    case "ad_creative_sku_map": return ds.creativeSkuMap as unknown as Record<string, unknown>[];
    case "campaign_grade_fact": return ds.campaignGrades as unknown as Record<string, unknown>[];
    case "attribution_fact": return ds.attribution as unknown as Record<string, unknown>[];
    case "inventory_level_fact": return ds.inventoryLevels as unknown as Record<string, unknown>[];
    case "sku_pnl": return ds.skuPnl as unknown as Record<string, unknown>[];
    case "sku_velocity": return ds.skuVelocity as unknown as Record<string, unknown>[];
    case "stockout_forecast": return ds.stockoutForecasts as unknown as Record<string, unknown>[];
  }
}

export interface SeedWriteSummary {
  wiped: string[];
  inserted: Record<string, number>;
}

/** Delete each table's shop-scoped rows in order, aborting on the first error.
 *  Shared with the demo reset (app/lib/demo/reset.server.ts) so wipe semantics
 *  can never drift between the two paths. */
export async function wipeShopTables(
  client: SeedWriterClient,
  tables: readonly string[],
  shopId: string,
): Promise<string[]> {
  const wiped: string[] = [];
  for (const table of tables) {
    const { error } = await client.from(table).delete().eq("shop_id", shopId);
    if (error) throw new Error(`wipe ${table}: ${error.message}`);
    wiped.push(table);
  }
  return wiped;
}

/** Insert rows in PostgREST-sized batches, aborting on the first error. */
export async function insertRowsBatched(
  client: SeedWriterClient,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await client.from(table).insert(batch);
    if (error) throw new Error(`insert ${table} (rows ${i}-${i + batch.length}): ${error.message}`);
  }
}

export async function writeSeedDataset(
  ds: SeedDataset,
  shopId: string,
  client: SeedWriterClient,
): Promise<SeedWriteSummary> {
  if (ds.skus.some((s) => s.shop_id !== shopId)) {
    throw new Error(`dataset was generated for a different shop than ${shopId}`);
  }

  const wiped = await wipeShopTables(client, WIPE_ORDER, shopId);

  const inserted: Record<string, number> = {};
  for (const table of INSERT_ORDER) {
    const rows = rowsFor(ds, table);
    await insertRowsBatched(client, table, rows);
    inserted[table] = rows.length;
  }

  return { wiped, inserted };
}
