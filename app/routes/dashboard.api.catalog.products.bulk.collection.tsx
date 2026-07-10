import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  validateBulkProductIds,
  runBulkProductAction,
  ownedProductIdSet,
  type BulkProductOutcome,
} from "~/lib/catalog/bulk.server";
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "~/lib/calderyn.server";

/**
 * Bulk add-to-collection (Catalog bulk actions). The collection is verified against the shop
 * once up front (404 on a foreign/missing id) and product ownership is pre-checked in one
 * select, so the per-id upsert never writes a membership row for something outside the shop.
 * The upsert ignores duplicates: re-adding a product already in the collection is a clean no-op,
 * not an error. Runs in batches of 5 via runBulkProductAction: one product failing never aborts
 * the rest of the selection.
 */
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const validated = validateBulkProductIds(body.product_ids);
  if (!validated.ok) return jsonError(422, validated.code, validated.message);

  const collectionId = body.collection_id;
  if (typeof collectionId !== "string" || !collectionId) {
    return jsonError(422, "invalid_collection_id", "collection_id must be a non-empty string.");
  }

  return dashboardJson(async () => {
    const sb = getSupabase();
    const { data: collection, error: cErr } = await sb
      .from("collection_dim")
      .select("id")
      .eq("shop_id", session.shopId)
      .eq("id", collectionId)
      .maybeSingle();
    if (cErr) throw cErr;
    if (!collection) {
      throw new CalderynError({ code: "collection_not_found", status: 404, message: "collection not found" });
    }

    const owned = await ownedProductIdSet(session.shopId, validated.productIds);
    const ownedIds = validated.productIds.filter((id) => owned.has(id));
    const ran = await runBulkProductAction(ownedIds, async (productId) => {
      const { error } = await sb
        .from("product_collection")
        .upsert(
          { product_id: productId, collection_id: collectionId },
          { onConflict: "product_id,collection_id", ignoreDuplicates: true },
        );
      if (error) throw error;
    });
    const byId = new Map(ran.map((r) => [r.product_id, r]));
    // Reassemble in the caller's (deduped) order, non-owned ids marked failed inline.
    const results: BulkProductOutcome[] = validated.productIds.map(
      (id) => byId.get(id) ?? { product_id: id, ok: false, error: "Not found." },
    );
    return { results };
  });
}
