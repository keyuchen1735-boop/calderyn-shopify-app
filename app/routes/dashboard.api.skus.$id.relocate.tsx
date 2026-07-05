// POST /dashboard/api/skus/:id/relocate
// { from_location_id, to_location_id, quantity, idempotency_key } →
// merchant-initiated inventory transfer. Dashboard mirror of the relocate
// action on app.skus.tsx: the inventory item and ownership checks are
// re-derived server-side by executeInventoryRelocation, never trusted from
// the request body.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import { unauthenticated } from "~/shopify.server";
import {
  executeInventoryRelocation,
  RelocationError,
} from "~/lib/actions/inventory-relocate.server";
import { getSupabase } from "~/lib/supabase.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const fromLocationId = String(body.from_location_id ?? "");
  const toLocationId = String(body.to_location_id ?? "");
  const quantity = Number(body.quantity);
  const idempotencyKey = String(body.idempotency_key ?? "");
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key");
  if (!fromLocationId || !toLocationId) return jsonError(422, "missing_location");
  if (!Number.isInteger(quantity) || quantity <= 0) return jsonError(422, "invalid_quantity");

  const skuId = String(params.id ?? "");
  if (!skuId) return jsonError(422, "missing_sku_id");

  return dashboardJson(async () => {
    // The relocation routes by the shop's cutover mode: at `live` the move lands in
    // Calderyn's own inventory engine and needs no Shopify admin, so an owned-native
    // shop (no connected store) can relocate too. Resolve the Shopify Admin client
    // only when the shop has one; the executor demands it on its Shopify-bound branch.
    const admin = session.shopDomain
      ? (await unauthenticated.admin(session.shopDomain)).admin
      : null;
    try {
      const result = await executeInventoryRelocation(
        session.shopId,
        { alertId: null, skuId, fromLocationId, toLocationId, quantity, idempotencyKey },
        getSupabase(),
        admin,
      );
      return { audit_id: result.id, outcome: result.outcome };
    } catch (err) {
      if (err instanceof RelocationError) {
        throw new CalderynError({
          code: err.code.toLowerCase(),
          status: 422,
          message: err.message,
        });
      }
      throw err;
    }
  });
}
