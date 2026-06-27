// POST { type, idempotency_key, daily_budget_cents? } → shared action pipeline.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { executeAction, type ExecutableKind } from "~/lib/actions/execute.server";
import type { RegionCode } from "~/lib/ads/actions";
import { getSupabase } from "~/lib/supabase.server";
import { calderynClient } from "~/lib/calderyn.server";
import { recordApproval } from "~/lib/calibration/approval.server";
import { ZERO_APPROVE_RECEIPT, type ApproveReceipt } from "~/lib/calibration/delta";

const KINDS: ExecutableKind[] = [
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "exclude_geo",
];
const REGIONS: readonly RegionCode[] = ["us-west", "us-east", "us-south", "us-central"];

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

  const kind = body.type as ExecutableKind;
  const idempotencyKey = String(body.idempotency_key ?? "");
  const dailyBudgetCents =
    body.daily_budget_cents === undefined ? undefined : Number(body.daily_budget_cents);

  const region = typeof body.region === "string" ? (body.region as RegionCode) : undefined;

  if (!KINDS.includes(kind)) return jsonError(422, "invalid_action_type");
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key");
  if (
    (kind === "reduce_campaign_budget" || kind === "increase_campaign_budget") &&
    (!Number.isFinite(dailyBudgetCents) || (dailyBudgetCents as number) <= 0)
  ) {
    return jsonError(422, "invalid_daily_budget_cents");
  }
  if (kind === "exclude_geo" && (!region || !REGIONS.includes(region))) {
    return jsonError(422, "invalid_region");
  }

  const alertId = typeof body.alert_id === "string" ? body.alert_id : null;
  const sb = getSupabase();

  const result = await executeAction(
    session.shopId,
    {
      alertId,
      kind,
      campaignId: String(params.id),
      idempotencyKey,
      dailyBudgetCents,
      region,
      actor: "merchant:web-dashboard",
    },
    sb,
  );

  if (result.outcome === "failed") {
    // Human `message` so the dashboard toast reads sensibly instead of the raw
    // "action_failed" code; the raw provider error stays in the audit row.
    return new Response(
      JSON.stringify({
        error: "action_failed",
        message: "Couldn't complete the action — the ad platform rejected it. See the action history for details.",
        audit_id: result.id,
        outcome: result.outcome,
      }),
      { status: 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  }

  // Calibration signal: bump approval confidence for the (detector, action) pair.
  // Only when a real alert drove this action (alertId present + outcome succeeded).
  // AWAITED before return so the promise is not abandoned on serverless cold-flush.
  // Guarded: a signal failure must NEVER affect the action result.
  // Capture the receipt so the Action Queue can render the approve confirmation
  // + graduation moment (drives "autopilot unlocked"). Still guarded: a signal
  // failure never affects the action result.
  let calibration: ApproveReceipt | undefined;
  if (result.outcome === "succeeded" && alertId) {
    const client = calderynClient(session.shopDomain);
    const alert = await client.alerts.get(alertId).catch(() => null);
    if (alert) {
      calibration = await recordApproval(session.shopId, alert.detector_id, kind, sb).catch(
        () => ZERO_APPROVE_RECEIPT,
      );
    }
  }

  return dashboardJson(async () => ({ audit_id: result.id, outcome: result.outcome, calibration }));
}
