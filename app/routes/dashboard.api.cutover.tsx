import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  getOrgMode,
  transitionOrgMode,
  isOrgMode,
  LEGAL_ORG_TRANSITIONS,
} from "~/lib/cutover/org-mode.server";
import { checkGoLiveGates } from "~/lib/cutover/go-live.server";
import { CutoverBlockedError } from "~/lib/cutover/errors";

// The cutover status envelope: current mode, where it can legally move next, and the
// full go-live gate report (shown as a checklist so the merchant always sees what is
// still standing between them and `live`).
async function cutoverStatus(shopId: string) {
  const mode = await getOrgMode(shopId);
  const gates = await checkGoLiveGates(shopId);
  return { mode, allowed: LEGAL_ORG_TRANSITIONS[mode], gates };
}

// GET: cutover status for the signed-in shop.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => await cutoverStatus(session.shopId));
}

// POST { to, reason? }: move the shop's org_mode. The state machine enforces legality
// and (for any move to `live`) the parity + payment-cleared gates. A blocked move —
// failing gate, illegal step, concurrent change — comes back as 409 carrying the exact
// reason so the dashboard shows it verbatim; anything else (a real DB/system failure)
// stays a 500 and never masquerades as a gate result.
export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = (await request.json().catch(() => null)) as {
    to?: unknown;
    reason?: unknown;
  } | null;
  const to = typeof body?.to === "string" ? body.to : "";
  if (!isOrgMode(to)) return jsonError(422, "bad_target_mode");
  const reason = typeof body?.reason === "string" ? body.reason : undefined;

  try {
    await transitionOrgMode(session.shopId, to, reason);
  } catch (err) {
    if (err instanceof CutoverBlockedError) {
      return jsonError(409, "cutover_blocked", err.message);
    }
    console.error("[dashboard.api.cutover] transition failed", err);
    return jsonError(500, "internal_error");
  }

  return dashboardJson(async () => await cutoverStatus(session.shopId));
}
