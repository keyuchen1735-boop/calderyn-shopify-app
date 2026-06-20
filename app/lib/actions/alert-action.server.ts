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
  inventoryAdjustQuantities,
  transferPlanFromEvidence,
  type AdminGraphqlClient,
} from "../shopify/inventory.server";
import type { ActionKind, Alert, AuditEntry, GuardrailConfig } from "../types";
import { discontinueProduct } from "../shopify/product.server";
import { resolveSkuForDiscontinue, setDoNotReorder } from "./discontinue.server";

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

/** Discontinue a SKU's product: set the internal do_not_reorder flag (blocks
 *  create_po_draft, shows on Inventory) AND archive the product on live Shopify.
 *  Same trust contract as executeInventoryAlertAction — every mutation input is
 *  re-derived from the alert record (its sku → sku_dim), never the request body.
 *  Reversible via the discontinue_sku branch in undo.server.ts. */
export async function executeDiscontinueAlertAction(opts: {
  client: AlertActionClient;
  admin: AdminGraphqlClient;
  sb: SupabaseClient;
  shopId: string;
  alertId: string;
  kind: "discontinue_sku";
  idempotencyKey: string;
  actor?: string;
  triggerReason?: string | null;
  signal?: AbortSignal;
}): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const { client, admin, sb, shopId, alertId, kind, idempotencyKey, actor, triggerReason, signal } = opts;

  const alert = await client.alerts.get(alertId, signal);

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

  const guardrails = await client.guardrails.get(signal);
  if (alert.dollar_impact > guardrails.dollar_cap_cents) {
    throw new CalderynError({
      code: "guardrail_dollar_cap",
      status: 403,
      message: `This action's impact (${fmtMoney(alert.dollar_impact)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
    });
  }

  if (!alert.sku) {
    throw new CalderynError({
      code: "discontinue_no_sku",
      status: 422,
      message: "This alert has no SKU to discontinue.",
    });
  }

  const target = await resolveSkuForDiscontinue(sb, shopId, alert.sku);
  if (!target) {
    throw new CalderynError({
      code: "sku_not_found",
      status: 422,
      message: "The alert's SKU was not found for this shop.",
    });
  }
  if (!target.productGid) {
    // Rule 12: surface WHY the move can't run rather than offering a dead button.
    throw new CalderynError({
      code: "discontinue_no_product",
      status: 422,
      message:
        "This SKU has no linked Shopify product, so it can't be archived. Discontinue it in Shopify directly.",
    });
  }

  // 1. Set the internal flag FIRST: a flagged-but-not-archived state is the safe
  //    failure mode (PO drafts are blocked even if the Shopify call later fails),
  //    and the undo clears it regardless.
  await setDoNotReorder(sb, shopId, target.skuId, true);

  // 2. Archive on Shopify. A failure here throws — the audit row below is only
  //    written on success (rule 12: no "succeeded" row for an un-archived product).
  let archivedStatus: string;
  try {
    ({ status: archivedStatus } = await discontinueProduct(admin, target.productGid));
  } catch (err) {
    // Roll the flag back so a failed archive doesn't silently block reorders.
    await setDoNotReorder(sb, shopId, target.skuId, false);
    throw new CalderynError({
      code: "action_failed",
      status: 502,
      message: err instanceof Error ? err.message : "Shopify product archive failed.",
    });
  }

  // 3. ONE audit row. params carries what undo needs: sku_id to clear the flag,
  //    product_id to restore the product. Matches how reallocate_inventory undo
  //    reads replay inputs from params, not pre_state.
  const params: Record<string, unknown> = {
    target: alert.sku,
    sku: alert.sku,
    sku_id: target.skuId,
    product_id: target.productGid,
    estimate_cents: alert.dollar_impact,
    archived_status: archivedStatus,
  };
  const audit = await client.actions.execute({ alertId, kind, params, idempotencyKey });

  const acknowledged = await acknowledgeAlert(sb, shopId, alertId);
  void actor;
  void triggerReason;
  return { auditId: audit.id, outcome: audit.outcome ?? "succeeded", acknowledged };
}
