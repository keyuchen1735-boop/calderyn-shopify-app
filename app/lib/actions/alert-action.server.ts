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
import { snoozeAlert } from "./snooze.server";
import {
  transferPlanFromEvidence,
  type AdminGraphqlClient,
} from "../shopify/inventory.server";
import { inventoryAdjustQuantitiesForShop } from "../demo/showcase.server";
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

  // Stale UIs (an open popover after a refresh, a replayed tab) must not
  // re-fire actions against an alert that already left the open queue.
  if (alert.status !== "open") {
    throw new CalderynError({
      code: "alert_not_open",
      status: 409,
      message: `This alert is ${alert.status}; actions only apply to open alerts.`,
    });
  }

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
    // alert.dollar_impact is dollars; dollar_cap_cents is cents — compare in
    // cents so a $500 cap actually caps at $500 (was 100x too lenient, P1-8).
    const impactCents = Math.round(alert.dollar_impact * 100);
    if (impactCents > guardrails.dollar_cap_cents) {
      throw new CalderynError({
        code: "guardrail_dollar_cap",
        status: 403,
        message: `This action's impact (${fmtMoney(impactCents)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
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
      ({ operationId } = await inventoryAdjustQuantitiesForShop(shopId, admin, plan, sb));
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

  // Snooze defers (hide for 1 day / until next login) rather than resolving;
  // every other kind closes the alert by acknowledging it.
  let acknowledged = false;
  if (kind === "snooze_alert") {
    await snoozeAlert(sb, shopId, alertId);
  } else {
    acknowledged = await acknowledgeAlert(sb, shopId, alertId);
  }

  return { auditId: audit.id, outcome: audit.outcome ?? "succeeded", acknowledged };
}
