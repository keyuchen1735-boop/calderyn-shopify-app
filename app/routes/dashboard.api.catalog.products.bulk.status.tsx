import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  validateBulkProductIds,
  runBulkProductAction,
  ownedProductIdSet,
  type BulkProductOutcome,
} from "~/lib/catalog/bulk.server";
import { setProductStatus } from "~/lib/catalog/catalog.server";
import type { ProductStatus } from "~/lib/catalog/types";

/**
 * Bulk product status change (Catalog bulk actions). Shares setProductStatus with the
 * single-product routes so the status update + sku_dim projection are written exactly once.
 * Ownership is pre-checked in one select: setProductStatus's shop-scoped UPDATE 404s on a
 * foreign/missing id, but pre-filtering keeps those rows out of the batch entirely and reports
 * them as plain "Not found." failures. Runs in batches of 5 via runBulkProductAction: one
 * product failing never aborts the rest of the selection.
 */
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const validated = validateBulkProductIds(body.product_ids);
  if (!validated.ok) return jsonError(422, validated.code, validated.message);

  const status = body.status;
  if (status !== "active" && status !== "draft" && status !== "archived") {
    return jsonError(422, "invalid_status", "status must be one of active, draft, archived.");
  }

  return dashboardJson(async () => {
    const owned = await ownedProductIdSet(session.shopId, validated.productIds);
    const ownedIds = validated.productIds.filter((id) => owned.has(id));
    const ran = await runBulkProductAction(ownedIds, async (productId) => {
      await setProductStatus(session.shopId, productId, status as ProductStatus);
    });
    const byId = new Map(ran.map((r) => [r.product_id, r]));
    // Reassemble in the caller's (deduped) order, non-owned ids marked failed inline.
    const results: BulkProductOutcome[] = validated.productIds.map(
      (id) => byId.get(id) ?? { product_id: id, ok: false, error: "Not found." },
    );
    return { results };
  });
}
