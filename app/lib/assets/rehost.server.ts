// app/lib/assets/rehost.server.ts
//
// Rehost sweep (#9, cron.assets). product_media rows written by the import
// promote path and the sourcing pick path carry third-party hotlinks in
// external_url (Shopify CDN / supplier CDNs). This sweep captures each pending
// hotlink into owned storage via mirrorShopifyImage and rewrites the row to
// the owned public URL, preserving the original in source_url. Write sites stay
// untouched: whatever they hotlink — including rows written before any inline
// adoption — the sweep heals on its next run.
//
// FAILURE HONESTY (rule 12): a failed fetch never drops the image — the row
// keeps its hotlink, rehost_attempts is incremented (capped so dead URLs stop
// consuming budget), and every skip class is counted in the returned summary.
import { getSupabase } from "~/lib/supabase.server";
import { mapWithConcurrency } from "~/lib/ads/concurrency";
import { mirrorShopifyImage, SHOP_ASSETS_BUCKET } from "./persist.server";

/** Substring of every owned public URL (any Supabase host) — the "already ours" predicate. */
export const OWNED_URL_MARKER = `/storage/v1/object/public/${SHOP_ASSETS_BUCKET}/`;
/** Rows at this many failed fetches are permanently skipped (dead URL). */
export const MAX_REHOST_ATTEMPTS = 5;
/** ponytail: fixed batch caps sized to the 300s function budget (worst case
 *  CONCURRENCY-parallel 15s fetches); a backlog drains across nightly runs. */
const SWEEP_LIMIT = 50;
const CONCURRENCY = 5;
/** Sibling-read bound; pending products are ≤SWEEP_LIMIT with a handful of
 *  images each, so this is generous — but never trust PostgREST's silent
 *  1000-row clamp to be "enough" (rule 12: bound it ourselves, visibly). */
const SIBLING_READ_LIMIT = 2000;

export interface SweepResult {
  /** Pending rows picked up this run. */
  scanned: number;
  /** Rewritten to an owned URL. */
  rehosted: number;
  /** Fetch/persist failed; hotlink kept, attempts incremented. */
  failed: number;
  /** Rows whose product no longer exists; skipped loudly. */
  orphaned: number;
  /** Hotlink duplicates of an already-rehosted image, deleted before re-persisting. */
  deduped: number;
}

interface PendingRow {
  id: string;
  product_id: string;
  external_url: string;
  rehost_attempts: number;
}

/**
 * One bounded sweep pass. Order matters: dedup runs BEFORE rehosting — a
 * re-promote/re-pick re-inserts an already-captured hotlink as a fresh pending
 * row (the (product_id, external_url) upsert key changed when we rewrote the
 * original), and rehosting that row first would mint a second owned copy the
 * dedup could then never recognize. Deleting it while it still carries the
 * hotlink also self-heals any dupes a previous crashed run left behind.
 */
export async function sweepPendingMedia(limit = SWEEP_LIMIT): Promise<SweepResult> {
  const sb = getSupabase();
  const result: SweepResult = { scanned: 0, rehosted: 0, failed: 0, orphaned: 0, deduped: 0 };

  const pending = await sb
    .from("product_media")
    .select("id, product_id, external_url, rehost_attempts")
    .is("source_url", null)
    .not("external_url", "is", null)
    .not("external_url", "like", `%${OWNED_URL_MARKER}%`)
    .lt("rehost_attempts", MAX_REHOST_ATTEMPTS)
    .order("rehost_attempts", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (pending.error) throw pending.error;
  let rows = (pending.data ?? []) as PendingRow[];
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  // Dedup pass: a pending hotlink equal to a sibling row's source_url is a
  // re-insert of an image we already own — delete it instead of re-persisting.
  const pendingProducts = [...new Set(rows.map((r) => r.product_id))];
  const siblings = await sb
    .from("product_media")
    .select("product_id, source_url")
    .in("product_id", pendingProducts)
    .not("source_url", "is", null)
    .limit(SIBLING_READ_LIMIT);
  if (siblings.error) throw siblings.error;
  const rehostedByProduct = new Map<string, Set<string>>();
  for (const m of (siblings.data ?? []) as Array<{ product_id: string; source_url: string }>) {
    const set = rehostedByProduct.get(m.product_id) ?? new Set<string>();
    set.add(m.source_url);
    rehostedByProduct.set(m.product_id, set);
  }
  const dupIds = rows
    .filter((r) => rehostedByProduct.get(r.product_id)?.has(r.external_url))
    .map((r) => r.id);
  if (dupIds.length > 0) {
    const del = await sb.from("product_media").delete().in("id", dupIds);
    if (del.error) throw del.error;
    result.deduped = dupIds.length;
    const dupSet = new Set(dupIds);
    rows = rows.filter((r) => !dupSet.has(r.id));
  }
  if (rows.length === 0) return result;

  // product_media carries no shop_id; resolve it through product_dim. A row whose
  // product is gone is unrecoverable here — skip it visibly, never silently.
  const products = await sb
    .from("product_dim")
    .select("id, shop_id")
    .in("id", [...new Set(rows.map((r) => r.product_id))]);
  if (products.error) throw products.error;
  const shopByProduct = new Map(
    ((products.data ?? []) as Array<{ id: string; shop_id: string }>).map((p) => [p.id, p.shop_id]),
  );

  const outcomes = await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    const shopId = shopByProduct.get(row.product_id);
    if (!shopId) {
      console.error(`[assets] rehost skipped media ${row.id}: product ${row.product_id} not found`);
      return "orphaned" as const;
    }
    const out = await mirrorShopifyImage(shopId, row.external_url);
    if (!out.persisted) {
      // mirrorShopifyImage already logged the cause; bound future retries.
      const upd = await sb
        .from("product_media")
        .update({ rehost_attempts: row.rehost_attempts + 1 })
        .eq("id", row.id);
      if (upd.error) console.error(`[assets] attempts bump failed for media ${row.id}`, upd.error);
      return "failed" as const;
    }
    const upd = await sb
      .from("product_media")
      .update({ external_url: out.url, source_url: row.external_url })
      .eq("id", row.id);
    if (upd.error) {
      console.error(`[assets] rehost stored but row update failed for media ${row.id}`, upd.error);
      return "failed" as const;
    }
    return "rehosted" as const;
  });

  for (const o of outcomes) {
    if (!o.ok) {
      // mapWithConcurrency isolates per-item throws; count and surface them.
      result.failed++;
      console.error("[assets] rehost worker threw", o.error);
    } else {
      result[o.value]++;
    }
  }

  return result;
}
