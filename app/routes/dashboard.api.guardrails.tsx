// GET returns the config; PUT applies a partial update through calderynClient.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";
import { validateGuardrailPatch } from "~/lib/dashboard/guardrails-validation";
import type { GuardrailConfig } from "~/lib/types";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    guardrails: await calderynClient(session.shopId).guardrails.get(),
  }));
}

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

  // Single source of truth for bounds (lib/dashboard/guardrails-validation.ts).
  // Response code stays generic for the web client; the specific code is internal.
  if (validateGuardrailPatch(patch) !== null) return jsonError(422, "invalid_guardrails");

  return dashboardJson(async () => ({
    guardrails: await calderynClient(session.shopId).guardrails.update(patch),
  }));
}
