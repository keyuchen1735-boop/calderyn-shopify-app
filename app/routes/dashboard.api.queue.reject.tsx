// POST { alertId, reason, note? } → { reflection, delta, before, after, savedAsRule }
//
// Dashboard-side reject endpoint — mirrors the embedded app.queue.tsx action,
// but uses the dashboard session + JSON body (not FormData). Security contract:
//   - Auth via requireDashboardSession (session shop, NEVER client-supplied).
//   - reason validated ∈ the 5 known RejectReason values; 400 otherwise.
//   - detector_id / action_kind / dollar_impact RE-DERIVED from the TRUSTED
//     alert via calderynClient(shop).alerts.get(alertId) — never trusted from
//     the request body.
//   - recordRejection executes NO action; it is purely bookkeeping + learning.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { recommendedAction } from "~/lib/labels";
import { muteConfirmationMessage } from "~/lib/calibration/mute-guard";
import type { RejectReason } from "~/lib/types";

const REJECT_REASONS: RejectReason[] = [
  "too_aggressive",
  "wrong_timing",
  "not_enough_data",
  "i_handle_this",
  "other",
];

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const alertId = String(body.alertId ?? "").trim();
  const reason = String(body.reason ?? "").trim() as RejectReason;
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;

  if (!alertId) return jsonError(400, "missing_alert_id");
  if (!REJECT_REASONS.includes(reason)) return jsonError(400, "invalid_reason");

  const client = calderynClient(session.shopId);

  return dashboardJson(async () => {
    // Re-derive from the TRUSTED alert — never trust form/body for detector/action/impact.
    const alert = await client.alerts.get(alertId);
    const detectorId = alert.detector_id;
    const hasCampaign = Boolean(alert.campaign_id);
    const actionKind = recommendedAction(detectorId, { hasCampaign });

    if (!actionKind) {
      throw jsonError(400, "no_recommended_action", "No recommended action for this alert");
    }

    // I8 interstitial: muting a shipped no-brainer requires an explicit second
    // confirmation — a 409 hands the warning to the picker, which re-posts
    // with confirmed=true. Enforced at the contract level so every surface
    // behaves identically.
    if (reason === "i_handle_this" && body.confirmed !== true) {
      const warning = muteConfirmationMessage(detectorId, actionKind);
      if (warning) throw jsonError(409, "confirm_required", warning);
    }

    // Record rejection — executes NOTHING; purely calibration bookkeeping.
    const r = await client.calibration.recordRejection({
      alertId,
      detectorId,
      actionKind,
      reason,
      note,
      dollarImpactCents: alert.dollar_impact,
    });

    // The full reject receipt drives the dashboard's "what Calderyn learned"
    // reflection card (mirrors the embedded surface).
    return {
      reflection: r.reflection,
      delta: r.delta,
      before: r.before,
      after: r.after,
      savedAsRule: r.savedAsRule,
    };
  });
}
