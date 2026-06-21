// GET  → { rules: LearnedRule[] }
// POST { ruleId } → { ok: true }  (undo/deactivate a rule)
//
// Learned-rule endpoints for the dashboard Calibration feature.
// Both branches are scoped to the session's shop — no client-supplied shop param.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const rules = await calderynClient(session.shopDomain).calibration.learnedRules();
    return { rules };
  });
}

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

  const ruleId = String(body.ruleId ?? "").trim();
  if (!ruleId) return jsonError(400, "missing_rule_id");

  return dashboardJson(async () => {
    await calderynClient(session.shopDomain).calibration.undoRule(ruleId);
    return { ok: true };
  });
}
