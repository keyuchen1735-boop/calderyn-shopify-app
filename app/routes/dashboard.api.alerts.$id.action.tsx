// POST { type: "reallocate_inventory" | "snooze_alert" | "discontinue_sku",
//        idempotency_key } → evidence-driven alert action. Thin wrapper over
// the shared executors (also used by the inventory page on both surfaces):
// the mutation inputs come from the alert's evidence/record, never the
// request body. Campaign kinds stay on /dashboard/api/campaigns/:id/action;
// exclude_geo / create_po_draft still have no dashboard endpoint.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { unauthenticated } from "~/shopify.server";
import {
  executeInventoryAlertAction,
  executeDiscontinueAlertAction,
  type InventoryAlertActionKind,
} from "~/lib/actions/alert-action.server";
import { getSupabase } from "~/lib/supabase.server";
import type { ActionKind } from "~/lib/types";

const KINDS: ActionKind[] = ["reallocate_inventory", "snooze_alert", "discontinue_sku"];

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

  const kind = body.type as ActionKind;
  const idempotencyKey = String(body.idempotency_key ?? "");
  if (!KINDS.includes(kind)) return jsonError(422, "invalid_action_type");
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key");

  const alertId = String(params.id);
  const client = calderynClient(session.shopDomain);

  return dashboardJson(async () => {
    const { admin } = await unauthenticated.admin(session.shopDomain);
    if (kind === "discontinue_sku") {
      const { auditId, outcome, acknowledged } = await executeDiscontinueAlertAction({
        client,
        admin,
        sb: getSupabase(),
        shopId: session.shopId,
        alertId,
        kind: "discontinue_sku",
        idempotencyKey,
        signal: request.signal,
      });
      return { audit_id: auditId, outcome, acknowledged };
    }
    const { auditId, outcome, acknowledged } = await executeInventoryAlertAction({
      client,
      admin,
      sb: getSupabase(),
      shopId: session.shopId,
      alertId,
      kind: kind as InventoryAlertActionKind,
      idempotencyKey,
      signal: request.signal,
    });
    return { audit_id: auditId, outcome, acknowledged };
  });
}
