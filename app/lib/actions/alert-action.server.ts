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
import { discontinueProduct } from "../shopify/product.server";
import { resolveSkuForDiscontinue, setDoNotReorder } from "./discontinue.server";
import { getOrgMode, writesToOwned, dualWrites } from "../cutover/org-mode.server";
import { resolveOwnedMoveTarget, applyOwnedInventoryMove } from "./owned-writes.server";

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
      actor?: string;
      triggerReason?: string | null;
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
  actor?: string;
  triggerReason?: string | null;
  signal?: AbortSignal;
}): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const { client, admin, sb, shopId, alertId, kind, idempotencyKey, actor, triggerReason, signal } = opts;

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
    // alert.dollar_impact is ALREADY in cents (rowToAlert converts the DB dollars
    // at the boundary), and so is dollar_cap_cents — compare directly. The prior
    // `* 100` double-converted and inflated the impact 100x.
    const impactCents = alert.dollar_impact;
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
    // Route the move by the shop's cutover mode, exactly like the dashboard relocate
    // (inventory-relocate.server.ts): at `live` the move lands in the owned engine
    // (atomic, cannot-oversell) keyed by owned ids resolved from the plan's Shopify
    // refs; every other mode adjusts Shopify as before, and dual_run ALSO mirrors the
    // move into the owned engine best-effort (recorded on the audit, never fatal).
    const orgMode = await getOrgMode(shopId);
    let operationId: string;
    if (writesToOwned(orgMode)) {
      const target = await resolveOwnedMoveTarget(shopId, {
        inventoryItemId: plan.inventoryItemId,
        fromLocationGid: plan.fromLocationId,
        toLocationGid: plan.toLocationId,
      });
      if (!target) {
        throw new CalderynError({
          code: "invalid_inventory_evidence",
          status: 422,
          message: "This alert's inventory item or locations aren't linked to the owned store.",
        });
      }
      try {
        const { transferId } = await applyOwnedInventoryMove({
          shopId,
          variantId: target.variantId,
          fromLocationId: target.fromLocationId,
          toLocationId: target.toLocationId,
          quantity: plan.delta,
        });
        operationId = transferId;
        params.owned = true;
        params.owned_transfer_id = transferId;
        params.owned_variant_id = target.variantId;
        params.owned_from_location_id = target.fromLocationId;
        params.owned_to_location_id = target.toLocationId;
      } catch (err) {
        throw new CalderynError({
          code: "action_failed",
          status: 502,
          message: err instanceof Error ? err.message : "Owned inventory move failed.",
        });
      }
    } else {
      try {
        ({ operationId } = await inventoryAdjustQuantitiesForShop(shopId, admin, plan, sb));
      } catch (err) {
        throw new CalderynError({
          code: "action_failed",
          status: 502,
          message: err instanceof Error ? err.message : "Shopify inventory adjustment failed.",
        });
      }
      if (dualWrites(orgMode)) {
        try {
          const target = await resolveOwnedMoveTarget(shopId, {
            inventoryItemId: plan.inventoryItemId,
            fromLocationGid: plan.fromLocationId,
            toLocationGid: plan.toLocationId,
          });
          if (!target) {
            params.dual_write = "skipped_unlinked";
          } else {
            const { transferId } = await applyOwnedInventoryMove({
              shopId,
              variantId: target.variantId,
              fromLocationId: target.fromLocationId,
              toLocationId: target.toLocationId,
              quantity: plan.delta,
            });
            params.dual_write = "ok";
            params.owned_transfer_id = transferId;
            params.owned_variant_id = target.variantId;
            params.owned_from_location_id = target.fromLocationId;
            params.owned_to_location_id = target.toLocationId;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          params.dual_write = `failed: ${msg}`;
          console.error("[alert-action] dual_run owned mirror move failed", err);
        }
      }
    }
    params.inventory_item_id = plan.inventoryItemId;
    params.from_location_id = plan.fromLocationId;
    params.to_location_id = plan.toLocationId;
    params.delta = plan.delta;
    params.shopify_operation_id = operationId;

    // sku_id is load-bearing for the engine SKU reward loop (reads params->>'sku_id').
    // Resolve from alert.sku → sku_dim, mirroring inventory-relocate.server.ts.
    if (alert.sku) {
      const { data: skuRow } = await sb
        .from("sku_dim")
        .select("id")
        .eq("shop_id", shopId)
        .eq("sku", alert.sku)
        .maybeSingle();
      if (skuRow?.id) {
        params.sku_id = String(skuRow.id);
      }
    }
  }

  const audit = await client.actions.execute({ alertId, kind, params, idempotencyKey, actor, triggerReason });

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
  const audit = await client.actions.execute({ alertId, kind, params, idempotencyKey, actor, triggerReason });

  const acknowledged = await acknowledgeAlert(sb, shopId, alertId);
  return { auditId: audit.id, outcome: audit.outcome ?? "succeeded", acknowledged };
}
