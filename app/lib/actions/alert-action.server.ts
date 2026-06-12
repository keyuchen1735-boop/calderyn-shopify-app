// Execute an inventory-relevant action against a shop-scoped alert. One code
// path shared by the dashboard alert-action route and the inventory page's
// per-row actions (both surfaces, same contract): everything that drives the
// mutation — the allowed kinds, the dollar impact, the transfer inputs — is
// re-derived from the alert record, never the request body.

import type { SupabaseClient } from "@supabase/supabase-js";
import { CalderynError } from "../calderyn.server";
import { DETECTOR_TO_ACTIONS } from "../labels";
import { fmtMoney } from "../format";
import { acknowledgeAlert } from "../alerts.server";
import {
  inventoryAdjustQuantities,
  transferPlanFromEvidence,
  type AdminGraphqlClient,
} from "../shopify/inventory.server";
import type { ActionKind, Alert, AuditEntry, GuardrailConfig } from "../types";

export type InventoryAlertActionKind = "reallocate_inventory" | "snooze_alert";

/** The slice of calderynClient(shop) this executor needs (keeps tests honest). */
export interface AlertActionClient {
  alerts: { get(id: string, signal?: AbortSignal): Promise<Alert> };
  guardrails: { get(signal?: AbortSignal): Promise<GuardrailConfig> };
  actions: {
    execute(opts: {
      alertId: string | null;
      kind: ActionKind;
      params: Record<string, unknown>;
      idempotencyKey: string;
    }): Promise<AuditEntry>;
  };
}

export async function executeInventoryAlertAction(opts: {
  client: AlertActionClient;
  admin: AdminGraphqlClient;
  sb: SupabaseClient;
  shopId: string;
  alertId: string;
  kind: InventoryAlertActionKind;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const { client, admin, sb, shopId, alertId, kind, idempotencyKey, signal } = opts;

  const alert = await client.alerts.get(alertId, signal);

  const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"];
  if (!allowed.includes(kind)) {
    throw new CalderynError({
      code: "action_not_allowed",
      status: 403,
      message: `"${kind}" is not a permitted action for this alert.`,
    });
  }

  // Per-action dollar cap from the alert's REAL impact. Snooze is a harmless
  // deferral and exempt (same rule as the alert detail page).
  if (kind !== "snooze_alert") {
    const guardrails = await client.guardrails.get(signal);
    if (alert.dollar_impact > guardrails.dollar_cap_cents) {
      throw new CalderynError({
        code: "guardrail_dollar_cap",
        status: 403,
        message: `This action's impact (${fmtMoney(alert.dollar_impact)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
      });
    }
  }

  const params: Record<string, unknown> = {
    target: alert.campaign ?? alert.sku ?? "",
    estimate_cents: alert.dollar_impact,
  };

  if (kind === "reallocate_inventory") {
    const plan = transferPlanFromEvidence(alert.evidence ?? {});
    if (!plan) {
      throw new CalderynError({
        code: "invalid_inventory_evidence",
        status: 422,
        message:
          "Alert evidence is missing the inventory item, source/destination location, or delta.",
      });
    }
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
    params.inventory_item_id = plan.inventoryItemId;
    params.from_location_id = plan.fromLocationId;
    params.to_location_id = plan.toLocationId;
    params.delta = plan.delta;
    params.shopify_operation_id = operationId;
  }

  const audit = await client.actions.execute({ alertId, kind, params, idempotencyKey });

  // Snooze is a deferral, not a resolution — leave the alert in the open queue.
  const acknowledged =
    kind === "snooze_alert" ? false : await acknowledgeAlert(sb, shopId, alertId);

  return { auditId: audit.id, outcome: audit.outcome ?? "succeeded", acknowledged };
}
