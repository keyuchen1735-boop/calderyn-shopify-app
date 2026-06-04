// app/lib/gdpr/sweep.server.ts
//
// Slice 5 — GDPR + data-retention sweep (queue-less, PostgREST-only).
//
// Ported from the monorepo `workers/gdpr-sweep`. Two responsibilities,
// both intended to run on a daily cron (`0 4 * * *` — see cron.gdpr.tsx):
//
//   1. Uninstalled-shop sweep. For each shop whose `uninstalled_at` is
//      older than UNINSTALL_GRACE_DAYS, cascade-delete every per-shop
//      table (children before parents, `shops` last). 30-day window
//      matches Shopify's GDPR `shop/redact` expectation.
//   2. Raw-webhook retention sweep. Trim `raw_shopify_webhook` rows
//      older than RETENTION_RAW_WEBHOOK_DAYS. Independent of uninstall:
//      an active shop's stale webhook rows are still trimmed.
//
// Unlike the monorepo (direct `postgres`/DATABASE_URL connection + a
// per-shop transaction), this runs via the Supabase PostgREST client
// (`getSupabase()`), one `.delete().eq('shop_id', id)` per table. There
// is no single multi-table transaction over PostgREST; per-table errors
// are collected and thrown so nothing is silently skipped (rule 12).

import type { SupabaseClient } from "@supabase/supabase-js";

export const UNINSTALL_GRACE_DAYS = 30;
export const RETENTION_RAW_WEBHOOK_DAYS = 30;

/**
 * Per-shop tables purged on redact, ordered children-before-parents so
 * each DELETE runs while its inbound FKs are already gone. Every table
 * here carries a `shop_id` column and was confirmed to exist in the live
 * schema (project ajgrmnvzxfxxlwrxcgnu) — a DELETE against a missing
 * table errors, so the list is reconciled against the live DB.
 *
 * FK invariants preserved from the monorepo test:
 *   undo_token  < action_audit  < alerts  < shops (shops LAST)
 *   order_line_fact / attribution_fact < order_fact
 *   ad_spend_fact / ad_creative_sku_map < ad_campaign_dim
 *   inventory_level_fact < location_dim, sku_dim
 *
 * Dropped from the monorepo's ordering because they do NOT exist (or
 * carry no `shop_id`) in this DB — fail visibly rather than error mid-sweep:
 *   - `shopify_sessions`              (exists, but keyed by id — no shop_id column)
 *   - `shops_onboarding_progress`     (table does not exist here)
 *   - `creative_mapping_nudge_dismissed` (table does not exist here)
 */
export const PER_SHOP_TABLES_PURGE_ORDER: readonly string[] = [
  // Audit + action chain (children first).
  "undo_token",
  "action_audit",
  "guardrail_config",
  "super_admin_session",
  "purchase_order_draft",
  // Alert chain.
  "alerts",
  "alert_context",
  // Fact tables (children first).
  "attribution_fact",
  "fulfillment_fact",
  "order_line_fact",
  "order_fact",
  "ad_spend_fact",
  "ad_creative_sku_map",
  "ad_campaign_dim",
  "inventory_level_fact",
  "sku_velocity",
  "sku_pnl",
  "stockout_forecast",
  "cogs_fact",
  "location_dim",
  "sku_dim",
  // Connector + raw.
  "raw_shopify_webhook",
  "shop_integrations",
  // Finally the root row itself.
  "shops",
];

export interface SweepResult {
  shopsRedacted: string[];
  /** Shops whose redact failed this run — surfaced, retried next tick. */
  shopsFailed: { id: string; error: string }[];
  rawWebhookRowsDeleted: number;
}

/**
 * Run the daily GDPR + retention sweep against `sb`. Exported so the
 * cron route and the test suite can call it directly.
 *
 * Per-shop isolation (rule 12, matching the cron.ingest pattern): a
 * delete failure for one shop is recorded in `shopsFailed` and the sweep
 * CONTINUES to the next candidate — one bad shop must not stall redaction
 * for every other shop past its 30-day window. Failures are surfaced, never
 * swallowed, and the shop is retried on the next tick (deletes are
 * idempotent). The root `shops` row is deleted by primary key `id`; every
 * other table by `shop_id`.
 */
export async function runGdprAndRetentionSweep(
  sb: SupabaseClient,
): Promise<SweepResult> {
  const shopsRedacted: string[] = [];
  const shopsFailed: { id: string; error: string }[] = [];

  // 1. Find uninstalled shops past the grace window.
  const cutoff = new Date(
    Date.now() - UNINSTALL_GRACE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: candidates, error: candErr } = await sb
    .from("shops")
    .select("id")
    .not("uninstalled_at", "is", null)
    .lt("uninstalled_at", cutoff);
  if (candErr) {
    throw new Error(`gdpr sweep: failed to load candidate shops: ${candErr.message}`);
  }

  for (const row of candidates ?? []) {
    const id = String((row as { id: string }).id);
    const errors: string[] = [];

    for (const table of PER_SHOP_TABLES_PURGE_ORDER) {
      // `shops` is the root row — match on its primary key, every other
      // per-shop table on `shop_id`.
      const column = table === "shops" ? "id" : "shop_id";
      const { error } = await sb.from(table).delete().eq(column, id);
      if (error) {
        errors.push(`${table}: ${error.message}`);
      }
    }

    if (errors.length > 0) {
      // Record this shop's failure and move on — never report a partial
      // redact as success (rule 12), but never let it abort the batch
      // either. Re-attempted next tick; the already-deleted tables no-op.
      const detail = errors.join("; ");
      shopsFailed.push({ id, error: detail });
      console.error(`[cron.gdpr] redact of shop ${id} failed`, detail);
      continue;
    }
    shopsRedacted.push(id);
  }

  // 2. Raw-webhook retention sweep. Count exactly without pulling rows.
  const rawCutoff = new Date(
    Date.now() - RETENTION_RAW_WEBHOOK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { error: rawErr, count } = await sb
    .from("raw_shopify_webhook")
    .delete({ count: "exact" })
    .lt("received_at", rawCutoff);
  if (rawErr) {
    throw new Error(`gdpr sweep: raw_shopify_webhook trim failed: ${rawErr.message}`);
  }

  return {
    shopsRedacted,
    shopsFailed,
    rawWebhookRowsDeleted: count ?? 0,
  };
}
