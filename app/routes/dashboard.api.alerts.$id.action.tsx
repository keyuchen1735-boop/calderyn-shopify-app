// POST { type: "reallocate_inventory", idempotency_key } → evidence-driven
// inventory transfer. Dashboard mirror of the reallocate_inventory block in
// app.alerts.$id.tsx: the mutation inputs come from the alert's evidence
// (written by the regional_spend_starved_stock detector), never the request
// body. Campaign kinds stay on /dashboard/api/campaigns/:id/action;
// exclude_geo / create_po_draft still have no dashboard endpoint.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { unauthenticated } from "~/shopify.server";
import {
  inventoryAdjustQuantities,
  transferPlanFromEvidence,
} from "~/lib/shopify/inventory.server";
import { acknowledgeAlert } from "~/lib/alerts.server";
import { getSupabase } from "~/lib/supabase.server";
import { DETECTOR_TO_ACTIONS } from "~/lib/labels";
import { fmtMoney } from "~/lib/format";
import type { ActionKind } from "~/lib/types";

const KINDS: ActionKind[] = ["reallocate_inventory"];

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
    // SECURITY: everything that drives the mutation — the allowed action, the
    // dollar impact, the inventory transfer inputs — is re-derived from the
    // shop-scoped alert record, never the request body.
    const alert = await client.alerts.get(alertId, request.signal);

    const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"];
    if (!allowed.includes(kind)) {
      throw new CalderynError({
        code: "action_not_allowed",
        status: 403,
        message: `"${kind}" is not a permitted action for this alert.`,
      });
    }

    const guardrails = await client.guardrails.get(request.signal);
    if (alert.dollar_impact > guardrails.dollar_cap_cents) {
      throw new CalderynError({
        code: "guardrail_dollar_cap",
        status: 403,
        message: `This action's impact (${fmtMoney(alert.dollar_impact)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
      });
    }

    const plan = transferPlanFromEvidence(alert.evidence ?? {});
    if (!plan) {
      throw new CalderynError({
        code: "invalid_inventory_evidence",
        status: 422,
        message:
          "Alert evidence is missing the inventory item, source/destination location, or delta.",
      });
    }

    const { admin } = await unauthenticated.admin(session.shopDomain);
    let operationId: string;
    try {
      ({ operationId } = await inventoryAdjustQuantities(admin, plan));
    } catch (err) {
      throw new CalderynError({
        code: "action_failed",
        status: 502,
        message: err instanceof Error ? err.message : "Shopify inventory adjustment failed.",
      });
    }

    const audit = await client.actions.execute({
      alertId,
      kind,
      params: {
        target: alert.campaign ?? alert.sku ?? "",
        estimate_cents: alert.dollar_impact,
        inventory_item_id: plan.inventoryItemId,
        from_location_id: plan.fromLocationId,
        to_location_id: plan.toLocationId,
        delta: plan.delta,
        shopify_operation_id: operationId,
      },
      idempotencyKey,
    });

    const acknowledged = await acknowledgeAlert(getSupabase(), session.shopId, alertId);
    return { audit_id: audit.id, outcome: "succeeded", acknowledged };
  });
}
