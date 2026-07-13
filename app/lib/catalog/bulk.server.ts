// Shared validation + batch runner for the bulk catalog routes (bulk status,
// bulk add-to-collection). Kept in one module so the "cap at MAX_BULK_PRODUCTS,
// dedupe" rule and the "one rejection never aborts the batch" rule are each
// written once — mirroring app/lib/order/bulk.server.ts with product vocabulary.
import { CalderynError } from "../calderyn.server";
import { getSupabase } from "../supabase.server";

export const MAX_BULK_PRODUCTS = 25;
const DEFAULT_BATCH_SIZE = 5;

export type BulkProductIdsResult =
  | { ok: true; productIds: string[] }
  | { ok: false; code: "invalid_product_ids" | "too_many_products"; message: string };

/**
 * Validate a bulk route's `product_ids` field: a non-empty array of non-empty strings,
 * deduped in first-seen order, capped at MAX_BULK_PRODUCTS after dedupe.
 */
export function validateBulkProductIds(raw: unknown): BulkProductIdsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      code: "invalid_product_ids",
      message: "product_ids must be a non-empty array of product id strings.",
    };
  }

  // Bound the loop before validating entries; the real cap of 25 still applies after dedupe.
  if (raw.length > 100) {
    return {
      ok: false,
      code: "too_many_products",
      message: `At most ${MAX_BULK_PRODUCTS} products per bulk action (got ${raw.length} entries before dedup).`,
    };
  }

  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry) {
      return { ok: false, code: "invalid_product_ids", message: "Each product id must be a non-empty string." };
    }
    ids.push(entry);
  }

  const deduped = [...new Set(ids)];
  if (deduped.length > MAX_BULK_PRODUCTS) {
    return {
      ok: false,
      code: "too_many_products",
      message: `At most ${MAX_BULK_PRODUCTS} products per bulk action (got ${deduped.length}).`,
    };
  }

  return { ok: true, productIds: deduped };
}

/**
 * The subset of `productIds` that belong to `shopId`. Both bulk routes pre-check ownership with
 * this single select and mark non-owned ids failed WITHOUT running the per-id action, because the
 * underlying writes are shop-scoped `.eq("shop_id", ...)` updates/upserts that silently no-op on
 * a foreign or missing id — a bulk route must not report `ok: true` for a row it never touched.
 */
export async function ownedProductIdSet(shopId: string, productIds: string[]): Promise<Set<string>> {
  const { data, error } = await getSupabase()
    .from("product_dim")
    .select("id")
    .eq("shop_id", shopId)
    .in("id", productIds);
  if (error) throw error;
  return new Set((data ?? []).map((r: { id: string }) => String(r.id)));
}

export type BulkProductOutcome =
  | { product_id: string; ok: true }
  | { product_id: string; ok: false; error: string };

const GENERIC_ERROR_MESSAGE = "Something went wrong.";

/** The CalderynError message when it's one, else a generic message — a bulk-action failure
 *  never leaks a raw exception's internals to the client. */
function messageFor(reason: unknown): string {
  return reason instanceof CalderynError ? reason.message : GENERIC_ERROR_MESSAGE;
}

/**
 * Run `fn` for every product id in batches of `batchSize` via Promise.allSettled, so one
 * product's rejection never aborts the batch or the rest of the ids — partial failure is the
 * normal, expected output of a bulk action, never a 500 for the whole request. Each settled
 * result maps to `{ product_id, ok: true }` or `{ product_id, ok: false, error }`. A
 * non-CalderynError rejection is logged loudly before being reduced to a generic
 * client-facing message.
 */
export async function runBulkProductAction(
  productIds: string[],
  fn: (productId: string) => Promise<void>,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<BulkProductOutcome[]> {
  const results: BulkProductOutcome[] = [];
  for (let i = 0; i < productIds.length; i += batchSize) {
    const batch = productIds.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((productId) => fn(productId)));
    settled.forEach((outcome, idx) => {
      const productId = batch[idx];
      if (outcome.status === "fulfilled") {
        results.push({ product_id: productId, ok: true });
        return;
      }
      if (!(outcome.reason instanceof CalderynError)) {
        console.error(`[catalog.bulk] unexpected error acting on product ${productId}`, outcome.reason);
      }
      results.push({ product_id: productId, ok: false, error: messageFor(outcome.reason) });
    });
  }
  return results;
}
