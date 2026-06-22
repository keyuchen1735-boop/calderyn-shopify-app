// POST { type: "reallocate_inventory" | "snooze_alert" | "discontinue_sku" | "reallocate_spend_sku",
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
import { executeReallocateSpendSku } from "~/lib/actions/reallocate-sku.server";
import { getSupabase } from "~/lib/supabase.server";
import type { ActionKind } from "~/lib/types";
import { recordApproval } from "~/lib/calibration/approval.server";
import { ZERO_APPROVE_RECEIPT, type ApproveReceipt } from "~/lib/calibration/delta";

const INVENTORY_KINDS: InventoryAlertActionKind[] = ["reallocate_inventory", "snooze_alert"];
const KINDS = [...INVENTORY_KINDS, "reallocate_spend_sku", "discontinue_sku"] as const satisfies readonly ActionKind[];

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

  const kind = body.type as (typeof KINDS)[number];
  const idempotencyKey = String(body.idempotency_key ?? "");
  if (!(KINDS as readonly string[]).includes(kind)) return jsonError(422, "invalid_action_type");
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key");

  const alertId = String(params.id);
  const client = calderynClient(session.shopDomain);
  const sb = getSupabase();

  return dashboardJson(async () => {
    if (kind === "reallocate_spend_sku") {
      const { auditId, outcome, acknowledged } = await executeReallocateSpendSku({
        client,
        sb: getSupabase(),
        shopId: session.shopId,
        alertId,
        idempotencyKey,
        actor: "merchant:web-dashboard",
        signal: request.signal,
      });
      return { audit_id: auditId, outcome, acknowledged };
    }
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
      sb,
      shopId: session.shopId,
      alertId,
      kind: kind as InventoryAlertActionKind,
      idempotencyKey,
      signal: request.signal,
    });

    // Calibration signal: bump approval confidence for the (detector, action) pair.
    // Only for real executed actions (snooze is not an approval of a fix).
    // Guarded: a signal failure must NEVER affect the action result.
    let calibration: ApproveReceipt | undefined;
    if (kind !== "snooze_alert") {
      const alert = await client.alerts.get(alertId).catch(() => null);
      if (alert) {
        calibration = await recordApproval(session.shopId, alert.detector_id, kind, sb).catch(
          () => ZERO_APPROVE_RECEIPT,
        );
      }
    }

    return { audit_id: auditId, outcome, acknowledged, calibration };
  });
}
