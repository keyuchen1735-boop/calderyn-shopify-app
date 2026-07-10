// /dashboard/api/po — the real purchase-order collection.
// GET  ?status=&offset= → { pos, total, promotedAuditIds } (promoted ids let the
//      screen hide already-converted Autopilot drafts).
// POST { intent: "create", ...po } | { intent: "promote_draft", auditId }.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import {
  createPurchaseOrder,
  isPoStatus,
  listPromotedAuditIds,
  listPurchaseOrders,
  promoteAuditDraft,
  validatePoBody,
} from "~/lib/po/purchase-orders.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const statusRaw = url.searchParams.get("status");
  if (statusRaw && !isPoStatus(statusRaw)) return jsonError(422, "invalid_status");
  const status = statusRaw && isPoStatus(statusRaw) ? statusRaw : undefined;
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset"))) || 0);
  return dashboardJson(async () => {
    const [page, promotedAuditIds] = await Promise.all([
      listPurchaseOrders(session.shopId, { status, offset }),
      listPromotedAuditIds(session.shopId),
    ]);
    return { pos: page.pos, total: page.total, promotedAuditIds };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  return dashboardJson(async () => {
    if (body.intent === "create") {
      return { po: await createPurchaseOrder(session.shopId, validatePoBody(body)) };
    }
    if (body.intent === "promote_draft") {
      const auditId = typeof body.auditId === "string" ? body.auditId : "";
      return { po: await promoteAuditDraft(session.shopId, auditId) };
    }
    throw new CalderynError({ code: "invalid_intent", status: 422, message: "Unknown intent." });
  });
}
