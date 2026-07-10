// Ops, autopilot & settings capabilities. This is the highest-stakes domain in
// the registry: issue_refund moves real money through Stripe and can NEVER be
// undone (undo.server.ts refuses it loudly), and update_guardrails/
// disconnect_integration change the rules the rest of the system runs under.
// All three are confirm-tier — the model can propose them but a merchant tap
// is required before anything executes. Everything else here (snooze, manual
// autopilot tick, undo, feature-autonomy toggle, import kickoff, peer
// consent) is execute-tier and low-blast-radius.
import { snoozeAlert } from "../../actions/snooze.server";
import { runAutopilotForShop } from "../../actions/autopilot.server";
import { undoAction } from "../../actions/undo.server";
import { executeRefundAction } from "../../actions/refund.server";
import { startImport, kickDrainSoon } from "../../import/run.server";
import { calderynClient } from "../../calderyn.server";
import { validateGuardrailPatch } from "../../dashboard/guardrails-validation";
import { getSupabase } from "../../supabase.server";
import {
  setShipCostMode,
  saveTypedPeriodTotal,
  setManualOverride,
  SHIP_COST_MODES,
  type ShipCostMode,
} from "../../ship-cost/inputs.server";
import type { ActionKind, GuardrailConfig } from "../../types";
import type { ActionReceipt, AssistantAction, ValidationResult } from "./registry-types";

const ACTOR = "merchant:assistant";

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

// Same list as dashboard.api.guardrails.tsx's PATCHABLE_KEYS — kept in sync
// manually since the route doesn't export it. A merchant can only ever
// change guardrails through this list, whether from Settings or the assistant.
const PATCHABLE_KEYS: (keyof GuardrailConfig)[] = [
  "daily_action_budget_cents",
  "dollar_cap_cents",
  "cooldown_minutes",
  "business_hours",
  "business_hours_only",
  "autopilot_enabled",
  "autopilot_bypass_guardrails",
  "autopilot_daily_action_cap",
  "autopilot_min_spend_cents",
  "autopilot_max_budget_cut_pct",
  "autopilot_max_budget_increase_pct",
  "autopilot_max_daily_budget_cents",
  "max_price_change_pct",
  "autopilot_max_price_change_pct",
  "autopilot_max_inventory_units_per_move",
  "weather_sensitivity",
  "merchant_lat",
  "merchant_lon",
];

function filterPatchableKeys(input: unknown): Partial<GuardrailConfig> {
  const patch: Partial<GuardrailConfig> = {};
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of PATCHABLE_KEYS) {
      if (key in obj) (patch as Record<string, unknown>)[key] = obj[key];
    }
  }
  return patch;
}

export const OPS_ACTIONS: AssistantAction[] = [
  {
    name: "snooze_alert",
    description: "Defer an open alert for one day; it auto-resurfaces then, or on the merchant's next login.",
    inputSchema: { type: "object", properties: { alert_id: { type: "string" } }, required: ["alert_id"] },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const alertId = str(i.alert_id);
      return alertId ? { ok: true, value: { alert_id: alertId } } : { ok: false, message: "alert_id is required" };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const alertId = String(i.alert_id);
      const ok = await snoozeAlert(getSupabase(), ctx.shopId, alertId);
      if (!ok) {
        throw new Error(`Could not snooze alert ${alertId} — it may not exist or is not open/snoozed.`);
      }
      return {
        action: "snooze_alert",
        summary: "Snoozed the alert until tomorrow (auto-resurfaces)",
        auditId: null,
        undoable: false,
        detail: { alert_id: alertId },
      };
    },
  },
  {
    name: "run_autopilot_now",
    description: "Run one autopilot tick for this shop immediately, instead of waiting for the next scheduled run.",
    inputSchema: { type: "object", properties: {}, required: [] },
    tier: "execute",
    undoable: false,
    validate: (): ValidationResult => ({ ok: true, value: {} }),
    run: async (ctx): Promise<ActionReceipt> => {
      const summary = await runAutopilotForShop(ctx.shopId, getSupabase());
      const summaryLine = summary.skipped
        ? "Autopilot is disabled for this shop; nothing was run"
        : `Ran autopilot: ${summary.acted} acted, ${summary.blocked} blocked, ${summary.failed} failed (of ${summary.considered} considered)`;
      return {
        action: "run_autopilot_now",
        summary: summaryLine,
        auditId: null,
        undoable: false,
        detail: { ...summary },
      };
    },
  },
  {
    name: "undo_action",
    description: "Reverse a prior action by its audit_id (from list_audit), replaying its recorded pre-state. Refused for actions outside their undo window, already undone, or never undoable (e.g. issue_refund).",
    inputSchema: { type: "object", properties: { audit_id: { type: "string" } }, required: ["audit_id"] },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const auditId = str(i.audit_id);
      return auditId ? { ok: true, value: { audit_id: auditId } } : { ok: false, message: "audit_id is required" };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const auditId = String(i.audit_id);
      const result = await undoAction(ctx.shopId, auditId, getSupabase(), {});
      return {
        action: "undo_action",
        summary: `Reversed action ${auditId}`,
        auditId: result.id,
        undoable: false,
        detail: { undone_audit_id: auditId },
      };
    },
  },
  {
    name: "toggle_feature_autonomy",
    description: "Turn a graduated (detector, action) pair's unattended autopilot autonomy on or off. Disabling is always safe; enabling only bites once the pair has graduated.",
    inputSchema: {
      type: "object",
      properties: {
        detector_id: { type: "string" },
        action_kind: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["detector_id", "action_kind", "enabled"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const detectorId = str(i.detector_id);
      const actionKind = str(i.action_kind);
      if (!detectorId) return { ok: false, message: "detector_id is required" };
      if (!actionKind) return { ok: false, message: "action_kind is required" };
      if (typeof i.enabled !== "boolean") return { ok: false, message: "enabled must be a boolean" };
      return { ok: true, value: { detector_id: detectorId, action_kind: actionKind, enabled: i.enabled } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const detectorId = String(i.detector_id);
      const actionKind = i.action_kind as ActionKind;
      const enabled = i.enabled === true;
      const result = await calderynClient(ctx.shopId).calibration.setFeatureAutonomy(detectorId, actionKind, enabled);
      if (!result.ok) {
        throw new Error(`Could not update autonomy for ${detectorId}/${actionKind}.`);
      }
      return {
        action: "toggle_feature_autonomy",
        summary: `Turned ${enabled ? "on" : "off"} autonomy for ${detectorId}/${actionKind}`,
        auditId: null,
        undoable: false,
        detail: { detector_id: detectorId, action_kind: actionKind, enabled },
      };
    },
  },
  {
    name: "start_import",
    description: "Start (or resume) importing this shop's data from Shopify. Idempotent — returns the in-progress run if one is already running.",
    inputSchema: { type: "object", properties: {}, required: [] },
    tier: "execute",
    undoable: false,
    validate: (): ValidationResult => ({ ok: true, value: {} }),
    run: async (ctx): Promise<ActionReceipt> => {
      const run = await startImport(ctx.shopId);
      await kickDrainSoon();
      return {
        action: "start_import",
        summary: "Started importing store data from Shopify",
        auditId: null,
        undoable: false,
        detail: { import_id: run.importId },
      };
    },
  },
  {
    name: "set_peer_consent",
    description: "Opt this shop in (or out) of contributing anonymized metrics to the peer-baseline comparison feature.",
    inputSchema: { type: "object", properties: { consent: { type: "boolean" } }, required: ["consent"] },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      if (typeof i.consent !== "boolean") return { ok: false, message: "consent must be a boolean" };
      return { ok: true, value: { consent: i.consent } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const consent = i.consent === true;
      await calderynClient(ctx.shopId).consent.set(consent);
      return {
        action: "set_peer_consent",
        summary: `Turned peer-baseline consent ${consent ? "on" : "off"}`,
        auditId: null,
        undoable: false,
        detail: { consent },
      };
    },
  },
  {
    name: "issue_refund",
    description: "Issue a Stripe refund on an owned order. order_id is the orders.id (not the Shopify order id). Omit amount_cents to refund the full remaining (captured minus already-refunded) balance. THIS CANNOT BE UNDONE — a Stripe refund has no reversal.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        amount_cents: { type: "number" },
        reason: { type: "string" },
      },
      required: ["order_id"],
    },
    tier: "confirm",
    undoable: false,
    validate: (i): ValidationResult => {
      const orderId = str(i.order_id);
      if (!orderId) return { ok: false, message: "order_id is required" };
      let amountCents: number | undefined;
      if (i.amount_cents !== undefined && i.amount_cents !== null) {
        const cents = posInt(i.amount_cents);
        if (!cents) return { ok: false, message: "amount_cents must be a positive integer (cents)" };
        amountCents = cents;
      }
      let reason: string | undefined;
      if (i.reason !== undefined && i.reason !== null) {
        if (typeof i.reason !== "string" || i.reason.length > 300) {
          return { ok: false, message: "reason must be a string of at most 300 chars" };
        }
        reason = i.reason;
      }
      const value: Record<string, unknown> = { order_id: orderId };
      if (amountCents !== undefined) value.amount_cents = amountCents;
      if (reason !== undefined) value.reason = reason;
      return { ok: true, value };
    },
    confirmSummary: async (_ctx, i) => {
      const amountCents = i.amount_cents;
      const amountLabel =
        amountCents !== undefined && amountCents !== null
          ? `$${(Number(amountCents) / 100).toFixed(2)}`
          : "the full remaining refund";
      return `Issue ${amountLabel} for order ${String(i.order_id)} — this cannot be undone.`;
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const orderId = String(i.order_id);
      const amountCents =
        i.amount_cents === undefined || i.amount_cents === null ? undefined : Number(i.amount_cents);
      const reason = typeof i.reason === "string" ? i.reason : null;
      const result = await executeRefundAction(
        ctx.shopId,
        { orderId, amountCents, idempotencyKey: ctx.idempotencyKey, actor: ACTOR, reason },
        getSupabase(),
      );
      return {
        action: "issue_refund",
        summary: `Refunded $${(result.amountCents / 100).toFixed(2)} on order ${orderId}`,
        auditId: result.auditId,
        undoable: false,
        detail: {
          refund_id: result.refundId,
          amount_cents: result.amountCents,
          order_state: result.orderState,
          refunded_total_cents: result.refundedTotalCents,
        },
      };
    },
  },
  {
    name: "update_guardrails",
    description: "Update one or more guardrail/autopilot settings. patch is an object whose keys are guardrail field names (see get_guardrails for the current values) — unknown keys are dropped. Requires confirmation.",
    inputSchema: {
      type: "object",
      properties: { patch: { type: "object" } },
      required: ["patch"],
    },
    tier: "confirm",
    undoable: false,
    validate: (i): ValidationResult => {
      const patch = filterPatchableKeys(i.patch);
      if (Object.keys(patch).length === 0) {
        return { ok: false, message: "patch must include at least one known guardrail key" };
      }
      const errCode = validateGuardrailPatch(patch);
      if (errCode !== null) {
        return { ok: false, message: `Invalid guardrail patch (${errCode}).` };
      }
      return { ok: true, value: { patch } };
    },
    confirmSummary: async (ctx, i) => {
      const patch = filterPatchableKeys(i.patch);
      let current: GuardrailConfig | null = null;
      try {
        current = await calderynClient(ctx.shopId).guardrails.get();
      } catch {
        // Old values are a nicety for the confirm card; proceed without them.
      }
      const lines = Object.keys(patch).map((key) => {
        const newVal = (patch as Record<string, unknown>)[key];
        if (current && key in current) {
          const oldVal = (current as unknown as Record<string, unknown>)[key];
          return `${key}: ${JSON.stringify(oldVal)} -> ${JSON.stringify(newVal)}`;
        }
        return `${key}: ${JSON.stringify(newVal)}`;
      });
      return `Update guardrails — ${lines.join(", ")}`;
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const patch = filterPatchableKeys(i.patch);
      const updated = await calderynClient(ctx.shopId).guardrails.update(patch);
      return {
        action: "update_guardrails",
        summary: `Updated guardrails: ${Object.keys(patch).join(", ")}`,
        auditId: null,
        undoable: false,
        detail: { patch, guardrails: updated },
      };
    },
  },
  {
    name: "set_ship_cost_mode",
    description:
      "Set how this shop's per-order shipping cost is estimated: auto (best available signal), force_measured (always prefer carrier-measured cost when present), or force_reconciled (always prefer the reconciled/typed period total).",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: [...SHIP_COST_MODES] } },
      required: ["mode"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const mode = str(i.mode);
      if (!mode || !(SHIP_COST_MODES as readonly string[]).includes(mode)) {
        return { ok: false, message: `mode must be one of ${SHIP_COST_MODES.join(", ")}` };
      }
      return { ok: true, value: { mode } };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const mode = i.mode as ShipCostMode;
      await setShipCostMode(getSupabase(), ctx.shopId, mode);
      return {
        action: "set_ship_cost_mode",
        summary: `Set the shipping-cost mode to ${mode}`,
        auditId: null,
        undoable: false,
        detail: { mode },
      };
    },
  },
  {
    name: "add_ship_cost_period",
    description:
      "Record a known total shipping spend (e.g. from a carrier invoice) for a date range, used to reconcile per-order shipping cost estimates. amount_cents is the total spend in cents; period_start/period_end are ISO date strings (e.g. 2026-06-01). carrier is optional (e.g. ups, usps, fedex).",
    inputSchema: {
      type: "object",
      properties: {
        amount_cents: { type: "number" },
        period_start: { type: "string" },
        period_end: { type: "string" },
        carrier: { type: "string" },
      },
      required: ["amount_cents", "period_start", "period_end"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const amountCents = posInt(i.amount_cents);
      const periodStart = str(i.period_start);
      const periodEnd = str(i.period_end);
      if (!amountCents) return { ok: false, message: "amount_cents must be a positive integer (cents)" };
      if (!periodStart) return { ok: false, message: "period_start is required (ISO date)" };
      if (!periodEnd) return { ok: false, message: "period_end is required (ISO date)" };
      const value: Record<string, unknown> = {
        amount_cents: amountCents,
        period_start: periodStart,
        period_end: periodEnd,
      };
      const carrier = str(i.carrier);
      if (carrier) value.carrier = carrier;
      return { ok: true, value };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const amountCents = Number(i.amount_cents);
      const periodStart = String(i.period_start);
      const periodEnd = String(i.period_end);
      const carrier = typeof i.carrier === "string" ? i.carrier : null;
      await saveTypedPeriodTotal(getSupabase(), ctx.shopId, {
        totalCents: amountCents,
        carrier,
        periodStart,
        periodEnd,
        shopCountry: null,
      });
      return {
        action: "add_ship_cost_period",
        summary: `Recorded $${(amountCents / 100).toFixed(2)} shipping spend for ${periodStart} to ${periodEnd}`,
        auditId: null,
        undoable: false,
        detail: { amount_cents: amountCents, period_start: periodStart, period_end: periodEnd, carrier },
      };
    },
  },
  {
    name: "set_order_ship_cost_override",
    description:
      "Manually set (or clear) an order's shipping cost override. order_id is the orders.id from order reads (not the Shopify order id). amount_cents is in cents; omit it (or pass null) to clear the override and fall back to the computed estimate.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" }, amount_cents: { type: "number" } },
      required: ["order_id"],
    },
    tier: "execute",
    undoable: false,
    validate: (i): ValidationResult => {
      const orderId = str(i.order_id);
      if (!orderId) return { ok: false, message: "order_id is required" };
      let amountCents: number | undefined;
      if (i.amount_cents !== undefined && i.amount_cents !== null) {
        const cents = nonNegInt(i.amount_cents);
        if (cents === null) return { ok: false, message: "amount_cents must be a non-negative integer (cents)" };
        amountCents = cents;
      }
      const value: Record<string, unknown> = { order_id: orderId };
      if (amountCents !== undefined) value.amount_cents = amountCents;
      return { ok: true, value };
    },
    run: async (ctx, i): Promise<ActionReceipt> => {
      const orderId = String(i.order_id);
      const cents = i.amount_cents === undefined || i.amount_cents === null ? null : Number(i.amount_cents);
      await setManualOverride(getSupabase(), ctx.shopId, { orderId, cents, shopCountry: null });
      return {
        action: "set_order_ship_cost_override",
        summary:
          cents === null
            ? `Cleared the shipping cost override for order ${orderId}`
            : `Set order ${orderId}'s shipping cost override to $${(cents / 100).toFixed(2)}`,
        auditId: null,
        undoable: false,
        detail: { order_id: orderId, amount_cents: cents },
      };
    },
  },
  {
    name: "disconnect_integration",
    description: "Disconnect a connected integration (e.g. meta, google, tiktok, quickbooks, easypost). Data ingestion stops until reconnected. Requires confirmation.",
    inputSchema: { type: "object", properties: { provider: { type: "string" } }, required: ["provider"] },
    tier: "confirm",
    undoable: false,
    validate: (i): ValidationResult => {
      const provider = str(i.provider);
      return provider ? { ok: true, value: { provider } } : { ok: false, message: "provider is required" };
    },
    confirmSummary: async (_ctx, i) => `Disconnect ${String(i.provider)} — data ingestion stops until reconnected`,
    run: async (ctx, i): Promise<ActionReceipt> => {
      const provider = String(i.provider);
      await calderynClient(ctx.shopId).integrations.disconnect(provider);
      return {
        action: "disconnect_integration",
        summary: `Disconnected ${provider}`,
        auditId: null,
        undoable: false,
        detail: { provider },
      };
    },
  },
];
