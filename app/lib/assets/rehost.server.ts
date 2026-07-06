// app/lib/assets/rehost.server.ts
//
// Rehost sweep (#9, cron.assets). product_media rows written by the import
// promote path and the sourcing pick path carry third-party hotlinks in
// external_url (Shopify CDN / supplier CDNs). This sweep captures each pending
// hotlink into owned storage via persistExternalImage and rewrites the row to
// the owned public URL, preserving the original in source_url. Write sites stay
// untouched: whatever they hotlink — including rows written before any inline
// adoption — the sweep heals on its next run.
//
// FAILURE HONESTY (rule 12): a failed fetch never drops the image — the row
// keeps its hotlink, rehost_attempts is incremented (capped so dead URLs stop
// consuming budget), and every skip class is counted in the returned summary.
import { getSupabase } from "~/lib/supabase.server";
import { persistExternalImage } from "./persist.server";

/** Substring of every owned public URL (any Supabase host) — the "already ours" predicate. */
export const OWNED_URL_MARKER = "/storage/v1/object/public/shop-assets/";
/** Rows at this many failed fetches are permanently skipped (dead URL). */
export const MAX_REHOST_ATTEMPTS = 5;
/** ponytail: fixed batch caps sized to the 300s function budget (worst case
 *  CONCURRENCY-parallel 15s fetches); a backlog drains across nightly runs. */
const SWEEP_LIMIT = 50;
const CONCURRENCY = 5;

export interface SweepResult {
  /** Pending rows picked up this run. */
  scanned: number;
  /** Rewritten to an owned URL. */
  rehosted: number;
  /** Fetch/persist failed; hotlink kept, attempts incremented. */
  failed: number;
  /** Rows whose product no longer exists; skipped loudly. */
  orphaned: number;
  /** Re-inserted hotlink duplicates of an already-rehosted row, deleted. */
  deduped: number;
}

interface PendingRow {
  id: string;
  product_id: string;
  external_url: string;
  rehost_attempts: number;
}

async function inPools<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

/**
 * One bounded sweep pass: rehost up to `limit` pending hotlinks, then delete
 * hotlink rows a re-promote/re-pick re-inserted for an already-rehosted image
 * (same product, external_url equal to a sibling's source_url).
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
  const rows = (pending.data ?? []) as PendingRow[];
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  // product_media carries no shop_id; resolve it through product_dim. A row whose
  // product is gone is unrecoverable here — skip it visibly, never silently.
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  const products = await sb.from("product_dim").select("id, shop_id").in("id", productIds);
  if (products.error) throw products.error;
  const shopByProduct = new Map(
    ((products.data ?? []) as Array<{ id: string; shop_id: string }>).map((p) => [p.id, p.shop_id]),
  );

  const touchedProducts = new Set<string>();
  await inPools(rows, CONCURRENCY, async (row) => {
    const shopId = shopByProduct.get(row.product_id);
    if (!shopId) {
      result.orphaned++;
      console.error(`[assets] rehost skipped media ${row.id}: product ${row.product_id} not found`);
      return;
    }
    const out = await persistExternalImage(shopId, row.external_url, "product", "mirrored");
    if (out.persisted) {
      const upd = await sb
        .from("product_media")
        .update({ external_url: out.url, source_url: row.external_url })
        .eq("id", row.id);
      if (upd.error) {
        result.failed++;
        console.error(`[assets] rehost stored but row update failed for media ${row.id}`, upd.error);
        return;
      }
      result.rehosted++;
      touchedProducts.add(row.product_id);
    } else {
      // persistExternalImage already logged the cause; bound future retries.
      result.failed++;
      const upd = await sb
        .from("product_media")
        .update({ rehost_attempts: row.rehost_attempts + 1 })
        .eq("id", row.id);
      if (upd.error) console.error(`[assets] attempts bump failed for media ${row.id}`, upd.error);
    }
  });

  // Dedup: promote/pick upserts key on (product_id, external_url), so after a
  // rewrite the same hotlink can be re-inserted as a NEW row next run. Any row
  // whose external_url matches a sibling's source_url is that duplicate.
  if (touchedProducts.size > 0) {
    const siblings = await sb
      .from("product_media")
      .select("id, product_id, external_url, source_url")
      .in("product_id", [...touchedProducts]);
    if (siblings.error) throw siblings.error;
    const all = (siblings.data ?? []) as Array<{
      id: string;
      product_id: string;
      external_url: string | null;
      source_url: string | null;
    }>;
    const rehostedByProduct = new Map<string, Set<string>>();
    for (const m of all) {
      if (!m.source_url) continue;
      if (!rehostedByProduct.has(m.product_id)) rehostedByProduct.set(m.product_id, new Set());
      rehostedByProduct.get(m.product_id)!.add(m.source_url);
    }
    const dupIds = all
      .filter((m) => !m.source_url && m.external_url != null)
      .filter((m) => rehostedByProduct.get(m.product_id)?.has(m.external_url as string))
      .map((m) => m.id);
    if (dupIds.length > 0) {
      const del = await sb.from("product_media").delete().in("id", dupIds);
      if (del.error) throw del.error;
      result.deduped = dupIds.length;
    }
  }

  return result;
}
