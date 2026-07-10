// /dashboard/api/po/:id — one purchase order.
// GET → { po: PoDetailDto }.
// POST intents: "update" (draft-only replace of header + lines), "mark_ordered"
// (draft → ordered; stock lands in incoming), "receive"
// ({receiptId, lines:[{lineId,qty}]}, incoming → on_hand; receiptId makes a
// retried submission a no-op), "cancel" (removes the remaining expectation). Every
// stock move happens inside the po_* SQL functions; this route only validates
// at the boundary and maps their named errcodes.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import {
  cancelPurchaseOrder,
  getPurchaseOrder,
  markOrdered,
  receiveLines,
  updateDraftPurchaseOrder,
  validatePoBody,
  validateReceiveBody,
} from "~/lib/po/purchase-orders.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const poId = params.id ?? "";
  return dashboardJson(async () => ({ po: await getPurchaseOrder(session.shopId, poId) }));
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  // A non-uuid id would reach Postgres as a cast error (22P02 → 500); it means
  // the same thing as an unknown PO, so 404 here like the loader does.
  const poId = params.id ?? "";
  if (!isUuid(poId)) return jsonError(404, "po_not_found");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  return dashboardJson(async () => {
    switch (body.intent) {
      case "update":
        return { po: await updateDraftPurchaseOrder(session.shopId, poId, validatePoBody(body)) };
      case "mark_ordered":
        return { po: await markOrdered(session.shopId, poId) };
      case "receive": {
        const { receiptId, lines } = validateReceiveBody(body);
        return { po: await receiveLines(session.shopId, poId, lines, receiptId) };
      }
      case "cancel":
        return { po: await cancelPurchaseOrder(session.shopId, poId) };
      default:
        throw new CalderynError({
          code: "invalid_intent",
          status: 422,
          message: "Unknown intent.",
        });
    }
  });
}
