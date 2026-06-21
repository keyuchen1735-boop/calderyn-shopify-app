// POST { type: "reallocate_inventory" | "snooze_alert", idempotency_key } →
// evidence-driven alert action. Thin wrapper over the shared
// executeInventoryAlertAction (also used by the inventory page on both
// surfaces): the mutation inputs come from the alert's evidence, never the
// request body. Campaign kinds stay on /dashboard/api/campaigns/:id/action;
// exclude_geo / create_po_draft still have no dashboard endpoint.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { unauthenticated } from "~/shopify.server";
import {
  executeInventoryAlertAction,
  type InventoryAlertActionKind,
} from "~/lib/actions/alert-action.server";
import { getSupabase } from "~/lib/supabase.server";
import { recordApproval } from "~/lib/calibration/approval.server";

const KINDS: InventoryAlertActionKind[] = ["reallocate_inventory", "snooze_alert"];

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

  const kind = body.type as InventoryAlertActionKind;
  const idempotencyKey = String(body.idempotency_key ?? "");
  if (!KINDS.includes(kind)) return jsonError(422, "invalid_action_type");
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key");

  const alertId = String(params.id);
  const client = calderynClient(session.shopDomain);
  const sb = getSupabase();

  return dashboardJson(async () => {
    const { admin } = await unauthenticated.admin(session.shopDomain);
    const { auditId, outcome, acknowledged } = await executeInventoryAlertAction({
      client,
      admin,
      sb,
      shopId: session.shopId,
      alertId,
      kind,
      idempotencyKey,
      signal: request.signal,
    });

    // Calibration signal: bump approval confidence for the (detector, action) pair.
    // Only for real executed actions (snooze is not an approval of a fix).
    // Guarded: a signal failure must NEVER affect the action result.
    if (kind !== "snooze_alert") {
      const alert = await client.alerts.get(alertId).catch(() => null);
      if (alert) {
        recordApproval(session.shopId, alert.detector_id, kind, sb).catch(() => {});
      }
    }

    return { audit_id: auditId, outcome, acknowledged };
  });
}
