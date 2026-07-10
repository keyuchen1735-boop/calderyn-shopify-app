// Alerts/queue capabilities — draft a purchase order from an alert's
// SKU/velocity evidence, or reject the recommended action and record why.
// reject_queue_action executes NOTHING against any ad platform; it is pure
// calibration bookkeeping and mirrors dashboard.api.queue.reject.tsx exactly,
// including re-deriving detector_id/action_kind/dollar_impact from the
// TRUSTED alert record rather than trusting model input.
import { executeCreatePoDraft } from "../../actions/po-action.server";
import { calderynClient } from "../../calderyn.server";
import { getSupabase } from "../../supabase.server";
import { recommendedAction } from "../../labels";
import { muteConfirmationMessage } from "../../calibration/mute-guard";
import type { RejectReason } from "../../types";
import type { ActionReceipt, AssistantAction, ValidationResult } from "./registry-types";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function posInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function nonNegInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const REJECT_REASONS: RejectReason[] = [
  "too_aggressive",
  "wrong_timing",
  "not_enough_data",
  "i_handle_this",
  "other",
];

export const ALERTS_ACTIONS: AssistantAction[] = [
  {
    name: "create_po_draft",
    description:
      "Draft a purchase order for the SKU behind an alert (alert_id from list_alerts). Requires an alert whose allowed_actions includes create_po_draft — a reorder/shortage alert (regional_shortage_risk, reorder_timing, scaling_sku_fulfillment_risk), not a campaign-spend alert. For a stocked-out SKU with ad spend (sku_stockout_vs_spend), the right backing alert is that SKU's reorder/shortage alert, not the campaign alert. quantity is a positive whole number of units; unit_cost_cents is optional (cents, blank for TBD).",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string" },
        quantity: { type: "number" },
        unit_cost_cents: { type: "number" },
      },
      required: ["alert_id", "quantity"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const alertId = str(i.alert_id);
      if (!alertId) return { ok: false, message: "alert_id is required" };
      const quantity = posInt(i.quantity);
      if (!quantity) return { ok: false, message: "quantity must be a positive integer" };
      const value: Record<string, unknown> = { alert_id: alertId, quantity };
      if (i.unit_cost_cents !== undefined && i.unit_cost_cents !== null) {
        const unitCostCents = nonNegInt(i.unit_cost_cents);
        if (unitCostCents === null) {
          return { ok: false, message: "unit_cost_cents must be a non-negative integer (cents)" };
        }
        value.unit_cost_cents = unitCostCents;
      }
      return { ok: true, value };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const client = calderynClient(ctx.shopId);
      const unitCostCents = i.unit_cost_cents;
      const unitCost =
        unitCostCents === undefined || unitCostCents === null
          ? ""
          : String(Number(unitCostCents) / 100);
      const result = await executeCreatePoDraft({
        client,
        sb: getSupabase(),
        shopId: ctx.shopId,
        shopDomain: ctx.shopId,
        alertId: String(i.alert_id),
        idempotencyKey: ctx.idempotencyKey,
        quantity: String(i.quantity),
        unitCost,
        signal: undefined,
      });
      if (result.outcome !== "succeeded") {
        throw new Error(
          `The purchase order draft did not complete (audit ${result.auditId}, outcome ${result.outcome}).`,
        );
      }
      return {
        action: "create_po_draft",
        summary:
          "Drafted the purchase order — view or download it below, or under Products → Purchase orders.",
        auditId: result.auditId,
        undoable: false,
        detail: { audit_id: result.auditId },
        link: { label: "View PO (PDF)", href: `/dashboard/api/audit/${result.auditId}/po.pdf` },
      };
    },
  },
  {
    name: "reject_queue_action",
    description:
      "Reject the recommended action on an alert and record why (calibration learning only — no side effect on any ad platform). reason must be one of: too_aggressive, wrong_timing, not_enough_data, i_handle_this, other.",
    inputSchema: {
      type: "object",
      properties: {
        alert_id: { type: "string" },
        reason: { type: "string", enum: REJECT_REASONS },
        note: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["alert_id", "reason"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const alertId = str(i.alert_id);
      if (!alertId) return { ok: false, message: "alert_id is required" };
      const reason = typeof i.reason === "string" ? (i.reason as RejectReason) : null;
      if (!reason || !REJECT_REASONS.includes(reason)) {
        return { ok: false, message: `reason must be one of: ${REJECT_REASONS.join(", ")}` };
      }
      const value: Record<string, unknown> = { alert_id: alertId, reason };
      if (i.note !== undefined && i.note !== null) {
        if (typeof i.note !== "string" || i.note.length > 300) {
          return { ok: false, message: "note must be a string of at most 300 chars" };
        }
        value.note = i.note;
      }
      if (i.confirm === true) value.confirm = true;
      return { ok: true, value };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const client = calderynClient(ctx.shopId);
      const alertId = String(i.alert_id);
      // Re-derive from the TRUSTED alert — never trust model input for
      // detector/action/impact (mirrors dashboard.api.queue.reject.tsx).
      const alert = await client.alerts.get(alertId);
      const detectorId = alert.detector_id;
      const actionKind = recommendedAction(detectorId, { hasCampaign: Boolean(alert.campaign_id) });
      if (!actionKind) {
        throw new Error("This alert has no recommended action to reject.");
      }

      const reason = i.reason as RejectReason;
      // I8 interstitial: muting a shipped no-brainer requires an explicit
      // second confirmation — the model relays this warning and the merchant
      // must re-ask with confirm:true before the mute applies.
      if (reason === "i_handle_this" && i.confirm !== true) {
        const warning = muteConfirmationMessage(detectorId, actionKind);
        if (warning) throw new Error(warning);
      }

      await client.calibration.recordRejection({
        alertId,
        detectorId,
        actionKind,
        reason,
        note: typeof i.note === "string" ? i.note : undefined,
        dollarImpactCents: alert.dollar_impact,
      });

      return {
        action: "reject_queue_action",
        summary: "Rejected the suggestion and recorded why",
        auditId: null,
        undoable: false,
      };
    },
  },
];
