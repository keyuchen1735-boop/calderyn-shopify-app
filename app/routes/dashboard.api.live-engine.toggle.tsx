// POST { detectorId, actionKind, enabled } → { ok, enabled }
//
// Turn a graduated feature's unattended autonomy on/off. Mirrors the embedded
// app.engine toggle action. Security: requireSameOrigin (CSRF) + the shop comes
// from requireDashboardSession, NEVER the body. Disabling is always safe;
// enabling only bites for a graduated pair while shop autopilot is on (the
// graduation gate, not this flag, is the real authority). setFeatureAutonomy
// flips pair_calibration.merchant_disabled and never throws.
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import type { ActionKind } from "~/lib/types";

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

  const detectorId = String(body.detectorId ?? "").trim();
  const actionKind = String(body.actionKind ?? "").trim() as ActionKind;
  const enabled = body.enabled === true;
  if (!detectorId || !actionKind) return jsonError(400, "missing_feature");

  const client = calderynClient(session.shopId);
  return dashboardJson(async () => {
    const r = await client.calibration.setFeatureAutonomy(detectorId, actionKind, enabled);
    if (!r.ok) {
      throw new CalderynError({
        code: "feature_autonomy_update_failed",
        status: 500,
        message: "Could not update this feature.",
      });
    }
    return { ok: r.ok, enabled };
  });
}
