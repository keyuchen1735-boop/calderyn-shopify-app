// Shared validation + batch runner for the three bulk order-action routes (Phase 2 Task 3:
// fulfill/archive/tags). Kept in one module so the "reject shopify:, cap at MAX_BULK_ORDERS,
// dedupe" rule and the "one rejection never aborts the batch" rule are each written once.
import { CalderynError } from "../calderyn.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "./detail.server";

export const MAX_BULK_ORDERS = 25;
const DEFAULT_BATCH_SIZE = 5;

export type BulkOrderIdsResult =
  | { ok: true; orderIds: string[] }
  | { ok: false; code: "invalid_order_ids" | "imported_read_only" | "too_many_orders"; message: string };

/**
 * Validate a bulk route's `order_ids` field: a non-empty array of 1-25 non-empty strings, each
 * with any `calderyn:` prefix stripped (mirroring the single-order routes), deduped in
 * first-seen order. A `shopify:`-prefixed (imported, read-only) id rejects the WHOLE request —
 * a bulk mutation never silently skips one order and proceeds with the rest for this case, since
 * that would leave the caller unsure which ids actually ran without inspecting the (absent) row.
 */
export function validateBulkOrderIds(raw: unknown): BulkOrderIdsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      code: "invalid_order_ids",
      message: "order_ids must be a non-empty array of order id strings.",
    };
  }

  const ids: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry) {
      return { ok: false, code: "invalid_order_ids", message: "Each order id must be a non-empty string." };
    }
    if (isImportedOrderId(entry)) {
      return {
        ok: false,
        code: "imported_read_only",
        message: `Order ${entry} is imported (read-only) and cannot be bulk-actioned.`,
      };
    }
    ids.push(stripNativeOrderPrefix(entry));
  }

  const deduped = [...new Set(ids)];
  if (deduped.length > MAX_BULK_ORDERS) {
    return {
      ok: false,
      code: "too_many_orders",
      message: `At most ${MAX_BULK_ORDERS} orders per bulk action (got ${deduped.length}).`,
    };
  }

  return { ok: true, orderIds: deduped };
}

/** A non-empty string idempotency key, or null when the field is missing/empty/not a string. */
export function validateIdempotencyKey(raw: unknown): string | null {
  return typeof raw === "string" && raw ? raw : null;
}

export type BulkActionOutcome =
  | ({ order_id: string; ok: true } & Record<string, unknown>)
  | { order_id: string; ok: false; error: string };

const GENERIC_ERROR_MESSAGE = "Something went wrong.";

/** The CalderynError message when it's one, else a generic message — a bulk-action failure
 *  never leaks a raw exception's internals to the client (rule 12 still requires it be logged
 *  loudly server-side, which the caller does before this runs). */
function messageFor(reason: unknown): string {
  return reason instanceof CalderynError ? reason.message : GENERIC_ERROR_MESSAGE;
}

/**
 * Run `fn` for every order id in batches of `batchSize` via Promise.allSettled, so one order's
 * rejection never aborts the batch or the rest of the ids — partial failure is the normal,
 * expected output of a bulk action, never a 500 for the whole request. Each settled result maps
 * to `{ order_id, ok: true, ...fn's small result object }` or `{ order_id, ok: false, error }`.
 * A non-CalderynError rejection is logged loudly (rule 12) before being reduced to a generic
 * client-facing message.
 */
export async function runBulkOrderAction(
  orderIds: string[],
  fn: (orderId: string) => Promise<Record<string, unknown>>,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<BulkActionOutcome[]> {
  const results: BulkActionOutcome[] = [];
  for (let i = 0; i < orderIds.length; i += batchSize) {
    const batch = orderIds.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((orderId) => fn(orderId)));
    settled.forEach((outcome, idx) => {
      const orderId = batch[idx];
      if (outcome.status === "fulfilled") {
        results.push({ order_id: orderId, ok: true, ...outcome.value });
        return;
      }
      if (!(outcome.reason instanceof CalderynError)) {
        console.error(`[order.bulk] unexpected error acting on order ${orderId}`, outcome.reason);
      }
      results.push({ order_id: orderId, ok: false, error: messageFor(outcome.reason) });
    });
  }
  return results;
}
