// app/lib/actions/reallocate-sku.server.ts
// SKU-scoped gateway for reallocate_spend_sku: the product-economics analogue of
// executeInventoryAlertAction. The loser->winner campaign pair and the shift
// amount are RE-DERIVED server-side from the trusted alert + enrichRemediation
// (never the request body), then handed to the shipped composite executor
// executeReallocation, which owns the two-leg budget shift, the single
// append-only action_audit row (action_kind "reallocate_budget"), undo, and the
// retry drain. This file adds only the SKU->campaign resolution + the alert
// gateway checks (open, allow-list, dollar cap, acknowledge).

import type { SupabaseClient } from "@supabase/supabase-js";
import { CalderynError } from "../calderyn.server";
import { DETECTOR_TO_ACTIONS } from "../labels";
import { fmtMoney } from "../format";
import { acknowledgeAlert } from "../alerts.server";
import { rankMoves, toNumericEvidence } from "../remediation/rank";
import { enrichRemediation } from "../remediation/enrich.server";
import { executeReallocation } from "./reallocate.server";
import type { Alert, GuardrailConfig } from "../types";

export interface ReallocateSkuClient {
  alerts: { get(id: string, signal?: AbortSignal): Promise<Alert> };
  guardrails: { get(signal?: AbortSignal): Promise<GuardrailConfig> };
}

export async function executeReallocateSpendSku(opts: {
  client: ReallocateSkuClient;
  sb: SupabaseClient;
  shopId: string;
  alertId: string;
  idempotencyKey: string;
  actor?: string;
  triggerReason?: string;
  signal?: AbortSignal;
}): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const { client, sb, shopId, alertId, idempotencyKey, actor, triggerReason, signal } = opts;

  const alert = await client.alerts.get(alertId, signal);

  if (alert.status !== "open") {
    throw new CalderynError({
      code: "alert_not_open",
      status: 409,
      message: `This alert is ${alert.status}; actions only apply to open alerts.`,
    });
  }

  const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"];
  if (!allowed.includes("reallocate_spend_sku")) {
    throw new CalderynError({
      code: "action_not_allowed",
      status: 403,
      message: `"reallocate_spend_sku" is not a permitted action for this alert.`,
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

  // Re-derive the campaign pair from the trusted alert, not the request body.
  const plan = await enrichRemediation(
    alert,
    rankMoves({
      detectorId: alert.detector_id,
      dollarImpactCents: alert.dollar_impact,
      evidence: toNumericEvidence(alert.evidence ?? {}),
    }),
    sb,
    shopId,
  );
  const move = plan.moves.find((m) => m.kind === "reallocate_to_winner");
  const t = move?.target;
  if (
    move?.executor !== "reallocate_spend_sku" ||
    !t?.loserCampaignId ||
    !t.winnerCampaignId ||
    !t.amountCents
  ) {
    throw new CalderynError({
      code: "reallocate_not_eligible",
      status: 422,
      message:
        move?.ineligibleReason ??
        "This product has no dedicated campaign or qualifying winner to reallocate between.",
    });
  }

  const audit = await executeReallocation(
    shopId,
    {
      alertId,
      sourceCampaignId: t.loserCampaignId,
      destCampaignId: t.winnerCampaignId,
      amountCents: t.amountCents,
      idempotencyKey,
      actor: actor ?? "merchant",
      triggerReason: triggerReason ?? undefined,
    },
    sb,
  );

  // Acknowledge the alert on success (open → acknowledged). Best-effort: a failure here never fails the already-executed budget shift.
  let acknowledged = false;
  if (audit.outcome === "succeeded") {
    acknowledged = await acknowledgeAlert(sb, shopId, alertId);
  }

  return { auditId: audit.id, outcome: audit.outcome, acknowledged };
}
