import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, jsonOk, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getVariantBalances, adjustStock, setReorderPoint, markUnavailable } from "~/lib/inventory/engine.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({ balances: await getVariantBalances(session.shopId, String(params.variantId)) }));
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "PUT") return jsonError(405, "method_not_allowed");
  const variantId = String(params.variantId);

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return jsonError(422, "invalid_json"); }
  const locationId = typeof body.locationId === "string" ? body.locationId : "";
  if (!locationId) return jsonError(422, "missing_location");

  try {
    switch (body.intent) {
      case "set_on_hand": {
        if (!Number.isFinite(body.onHand)) return jsonError(422, "invalid_quantity");
        await adjustStock(session.shopId, variantId, locationId, Math.max(0, Math.trunc(Number(body.onHand))), typeof body.reason === "string" ? body.reason : undefined);
        return jsonOk({ ok: true });
      }
      case "set_reorder": {
        const rp = body.reorderPoint == null ? null : Math.max(0, Math.trunc(Number(body.reorderPoint)));
        if (rp != null && !Number.isFinite(rp)) return jsonError(422, "invalid_quantity");
        await setReorderPoint(session.shopId, variantId, locationId, rp);
        return jsonOk({ ok: true });
      }
      case "mark_unavailable": {
        const qty = Math.trunc(Number(body.qty));
        if (!Number.isFinite(qty) || qty < 1) return jsonError(422, "invalid_quantity");
        await markUnavailable(session.shopId, variantId, locationId, qty, typeof body.reason === "string" ? body.reason : "damaged");
        return jsonOk({ ok: true });
      }
      default:
        return jsonError(422, "unknown_intent");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "insufficient_available") return jsonError(422, "insufficient_available", "Not enough available stock to mark unavailable.");
    if (msg === "no_balance_row") return jsonError(422, "no_balance_row", "No stock recorded at this location yet.");
    console.error("[inventory.api] mutation failed", err);
    return jsonError(500, "internal_error");
  }
}
