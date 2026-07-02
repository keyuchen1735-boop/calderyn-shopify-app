// app/lib/gdpr/sweep.server.ts
//
// Slice 5 — GDPR + data-retention sweep (queue-less, PostgREST-only).
//
// Two responsibilities, both intended to run on a daily cron (`0 4 * * *` —
// see cron.gdpr.tsx):
//
//   1. Uninstalled-shop redact. For each shop whose `uninstalled_at` is older
//      than UNINSTALL_GRACE_DAYS, delete the root `shops` row. Every per-shop
//      table carries a `shop_id` FK to `shops(id)` declared ON DELETE CASCADE
//      (verified across all 34 such FKs in the live schema), so this ONE delete
//      cascades to every child atomically. The 30-day window matches Shopify's
//      GDPR `shop/redact` expectation: a merchant gets a month to reinstall
//      before data is purged.
//   2. Raw-webhook retention. Trim `raw_shopify_webhook` rows older than
//      RETENTION_RAW_WEBHOOK_DAYS. Independent of uninstall: an active shop's
//      stale webhook rows are still trimmed.
//
// Why a single cascading delete (not an ordered per-table loop): the cascade
// runs in one statement — atomic, with no half-redact window, no ~24 round
// trips per shop, and no risk of a per-shop table being forgotten from a
// hand-maintained list. The monorepo used an ordered loop because its queue
// worker held a direct `postgres` transaction; here we rely on the DB's own
// referential-action guarantee instead.
//
// SCHEMA INVARIANT (the thing that makes redaction complete): every per-shop
// table must have its `shop_id` FK to `shops(id)` declared ON DELETE CASCADE.
// A new per-shop table added WITHOUT that cascade would silently survive a
// redact — keep the cascade on every such FK. (Tables that hold no `shops` FK,
// e.g. `shopify_sessions`, are out of scope here and unchanged by this sweep.)
//
// Per-shop isolation (rule 12, matching the cron.ingest pattern): a delete
// failure for one shop is recorded in `shopsFailed` and the sweep CONTINUES to
// the next candidate — one bad shop must not stall redaction for every other
// shop past its 30-day window. Failures are surfaced, never swallowed, and the
// shop is retried on the next tick (the delete is idempotent).

import type { SupabaseClient } from "@supabase/supabase-js";

export const UNINSTALL_GRACE_DAYS = 30;
export const RETENTION_RAW_WEBHOOK_DAYS = 30;
export const RETENTION_STOREFRONT_EVENT_DAYS = 30;

export interface SweepResult {
  shopsRedacted: string[];
  /** Shops whose redact failed this run — surfaced, retried next tick. */
  shopsFailed: { id: string; error: string }[];
  rawWebhookRowsDeleted: number;
  storefrontEventRowsDeleted: number;
}

/**
 * Run the daily GDPR + retention sweep against `sb`. Exported so the cron route
 * and the test suite can call it directly.
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
    // One atomic, cascading delete per shop: every per-shop FK to shops(id) is
    // ON DELETE CASCADE, so this removes all of the shop's child rows too.
    const { error } = await sb.from("shops").delete().eq("id", id);
    if (error) {
      // Record and move on — never report a partial redact as success
      // (rule 12), but never let one shop abort the batch either.
      shopsFailed.push({ id, error: error.message });
      console.error(`[cron.gdpr] redact of shop ${id} failed`, error.message);
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

  // Tracking identifiers: purge click-id breadcrumbs past the retention window.
  // (attribution_fact keeps the resolved result; the raw click-id does not persist.)
  const { error: clickRefErr } = await sb
    .from("ad_click_ref")
    .delete()
    .lt("captured_at", rawCutoff);
  if (clickRefErr) {
    throw new Error(`gdpr sweep: ad_click_ref trim failed: ${clickRefErr.message}`);
  }

  // 3. Live-view event retention. storefront_event feeds the live view, not
  //    the warehouse — rows past the window are dead weight (spec
  //    2026-07-02-analytics-live-view-design.md).
  const eventCutoff = new Date(
    Date.now() - RETENTION_STOREFRONT_EVENT_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { error: evErr, count: evCount } = await sb
    .from("storefront_event")
    .delete({ count: "exact" })
    .lt("created_at", eventCutoff);
  if (evErr) {
    throw new Error(`gdpr sweep: storefront_event trim failed: ${evErr.message}`);
  }

  return {
    shopsRedacted,
    shopsFailed,
    rawWebhookRowsDeleted: count ?? 0,
    storefrontEventRowsDeleted: evCount ?? 0,
  };
}
