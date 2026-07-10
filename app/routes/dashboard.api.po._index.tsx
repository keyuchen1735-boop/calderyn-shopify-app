// /dashboard/api/po — the real purchase-order collection.
// GET  ?offset=&auditIds=a,b,c → { pos, total, promotedAuditIds } — auditIds is
//      the screen's VISIBLE Autopilot drafts (bounded ≤50); the response says
//      which of them were already converted so the screen can hide them.
//      Pagination requests (offset > 0) skip the promoted lookup entirely.
// POST { intent: "create", ...po } | { intent: "promote_draft", auditId }.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import {
  createPurchaseOrder,
  listPromotedAuditIds,
  listPurchaseOrders,
  promoteAuditDraft,
  validatePoBody,
} from "~/lib/po/purchase-orders.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset"))) || 0);
  const auditIds = (url.searchParams.get("auditIds") ?? "")
    .split(",")
    .filter((id) => isUuid(id))
    .slice(0, 50);
  return dashboardJson(async () => {
    const [page, promotedAuditIds] = await Promise.all([
      listPurchaseOrders(session.shopId, { offset }),
      offset === 0 ? listPromotedAuditIds(session.shopId, auditIds) : Promise.resolve([]),
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
