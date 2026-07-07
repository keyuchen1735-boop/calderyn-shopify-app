// POST { type: "reallocate_inventory" | "snooze_alert" | "discontinue_sku" |
//        "reallocate_spend_sku" | "adjust_price", idempotency_key,
//        new_price_cents? } → evidence-driven alert action. Thin wrapper over
// the shared executors (also used by the inventory page on both surfaces):
// the mutation inputs come from the alert's evidence/record, never the request
// body — the one exception is adjust_price's optional new_price_cents (a
// merchant override, bounded to ±the price cap by the executor; and
// create_po_draft's po_quantity/po_unit_cost, which shape a local document
// only). Campaign kinds stay on /dashboard/api/campaigns/:id/action; exclude_geo
// still has no dashboard endpoint.

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
import { executeAdjustPriceAlertAction } from "~/lib/actions/adjust-price.server";
import { executeCreatePoDraft } from "~/lib/actions/po-action.server";
import { executeReallocation } from "~/lib/actions/reallocate.server";
import { reallocationPlanFromEvidence } from "~/lib/weather/reallocation-plan";
import { getSupabase } from "~/lib/supabase.server";
import { acknowledgeAlert } from "~/lib/alerts.server";
import type { ActionKind } from "~/lib/types";
import { recordApproval } from "~/lib/calibration/approval.server";
import { recordActionFailure } from "~/lib/calibration/failure.server";
import { ZERO_APPROVE_RECEIPT, type ApproveReceipt } from "~/lib/calibration/delta";

const INVENTORY_KINDS: InventoryAlertActionKind[] = ["reallocate_inventory", "snooze_alert"];
const KINDS = [...INVENTORY_KINDS, "reallocate_spend_sku", "discontinue_sku", "adjust_price", "create_po_draft", "reallocate_budget"] as const satisfies readonly ActionKind[];

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
  const client = calderynClient(session.shopId);
  const sb = getSupabase();

  return dashboardJson(async () => {
    const recordCalibration = async (
      kindToRecord: ActionKind,
      outcome: string,
      auditId?: string,
    ): Promise<ApproveReceipt | undefined> => {
      if (kindToRecord === "snooze_alert") return undefined;
      // +alpha on success, +beta on a terminal platform failure (spec §7,
      // once-per-audit via the failure ledger); `retrying` records nothing yet.
      if (outcome !== "succeeded" && outcome !== "failed") return undefined;
      const alert = await client.alerts.get(alertId).catch(() => null);
      if (!alert) return undefined;
      if (outcome === "failed") {
        await recordActionFailure(session.shopId, alert.detector_id, kindToRecord, sb, {
          auditId,
          alertId,
        });
        return undefined;
      }
      return recordApproval(session.shopId, alert.detector_id, kindToRecord, sb, {
        auditId,
        alertId,
      }).catch(() => ZERO_APPROVE_RECEIPT);
    };

    if (kind === "create_po_draft") {
      // Local document only (no external mutation) — qty/cost are the validated
      // exception to "inputs come from evidence". The SKU + title come from the
      // alert. The PDF is rendered on demand from the audit snapshot.
      const { auditId, outcome, acknowledged } = await executeCreatePoDraft({
        client,
        sb,
        shopId: session.shopId,
        shopDomain: session.shopDomain ?? session.shopId,
        alertId,
        idempotencyKey,
        quantity: String(body.po_quantity ?? ""),
        unitCost: String(body.po_unit_cost ?? ""),
        signal: request.signal,
      });
      const calibration = await recordCalibration(kind, outcome, auditId);
      return { audit_id: auditId, outcome, acknowledged, calibration };
    }
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
      const calibration = await recordCalibration(kind, outcome, auditId);
      return { audit_id: auditId, outcome, acknowledged, calibration };
    }
    if (kind === "reallocate_budget") {
      // weather_demand carries a concrete reallocation plan (source/dest
      // campaign + amount) in its evidence; other reallocate_budget-listing
      // detectors (e.g. ad_tax_overload) don't, so the one-click gate on the
      // client already filters those out — this 422 is the server-side
      // backstop for a direct/replayed request without a real plan.
      const alert = await client.alerts.get(alertId).catch(() => null);
      const plan = reallocationPlanFromEvidence(alert?.evidence ?? null);
      // throw (not return): inside dashboardJson a returned Response is wrapped
      // as 200; only a thrown Response propagates as the real 422.
      if (!plan) throw jsonError(422, "invalid_reallocation_evidence");
      const result = await executeReallocation(
        session.shopId,
        {
          alertId,
          sourceCampaignId: plan.sourceCampaignId,
          destCampaignId: plan.destCampaignId,
          amountCents: plan.amountCents,
          idempotencyKey,
          actor: "merchant:web-dashboard",
          triggerReason: "weather",
        },
        sb,
      );
      // Resolve the alert out of the open queue on success, exactly as the
      // other executors do (their own executeAlertAction calls acknowledgeAlert).
      // Without this the alert stays 'open' and re-approving it runs a SECOND
      // budget move (each click mints a fresh idempotency key).
      const acknowledged =
        result.outcome === "succeeded" || result.outcome === "retrying"
          ? await acknowledgeAlert(sb, session.shopId, alertId)
          : false;
      const calibration = await recordCalibration(kind, result.outcome, result.id);
      return { audit_id: result.id, outcome: result.outcome, acknowledged, calibration };
    }
    // reallocate_inventory and adjust_price route by the shop's cutover mode: at
    // `live` the write lands in Calderyn's own engine and needs no Shopify admin,
    // so an owned-native shop (no connected Shopify store) can still run them. We
    // therefore resolve the Shopify Admin client only when the shop has one and let
    // each executor demand it on its Shopify-bound branch (they surface a clear
    // shopify_required error if it's genuinely missing). discontinue_sku always
    // archives on live Shopify, so it still requires a connected store here.
    const admin = session.shopDomain
      ? (await unauthenticated.admin(session.shopDomain)).admin
      : null;
    if (kind === "adjust_price") {
      // new_price_cents is an optional merchant override; omit → engine suggestion.
      // The executor bounds either to ±the price cap and reads the live price.
      const newPriceCents =
        body.new_price_cents === undefined ? undefined : Number(body.new_price_cents);
      const { auditId, outcome, acknowledged } = await executeAdjustPriceAlertAction({
        client,
        admin,
        sb: getSupabase(),
        shopId: session.shopId,
        alertId,
        kind: "adjust_price",
        idempotencyKey,
        newPriceCents,
        actor: "merchant:web-dashboard",
        signal: request.signal,
      });
      const calibration = await recordCalibration(kind, outcome, auditId);
      return { audit_id: auditId, outcome, acknowledged, calibration };
    }
    if (kind === "discontinue_sku") {
      if (!admin) {
        // Discontinue archives the product on live Shopify — there is no owned
        // equivalent yet, so this action requires a connected store (rule 12).
        throw jsonError(422, "shopify_required", "Connect a Shopify store to use this action.");
      }
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
      const calibration = await recordCalibration(kind, outcome, auditId);
      return { audit_id: auditId, outcome, acknowledged, calibration };
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
    const calibration = await recordCalibration(kind, outcome, auditId);

    return { audit_id: auditId, outcome, acknowledged, calibration };
  });
}
