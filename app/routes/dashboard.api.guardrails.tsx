// GET returns the config; PUT applies a partial update through calderynClient.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import type { GuardrailConfig } from "~/lib/types";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    guardrails: await calderynClient(session.shopDomain).guardrails.get(),
  }));
}

const PATCHABLE_KEYS: (keyof GuardrailConfig)[] = [
  "daily_action_budget_cents",
  "dollar_cap_cents",
  "cooldown_minutes",
  "business_hours",
  "autopilot_enabled",
  "autopilot_daily_action_cap",
  "autopilot_min_spend_cents",
  "autopilot_max_budget_cut_pct",
];

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "PUT") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const patch: Partial<GuardrailConfig> = {};
  for (const key of PATCHABLE_KEYS) {
    if (key in body) (patch as Record<string, unknown>)[key] = body[key];
  }
  if (Object.keys(patch).length === 0) return jsonError(422, "empty_patch");

  return dashboardJson(async () => ({
    guardrails: await calderynClient(session.shopDomain).guardrails.update(patch),
  }));
}
