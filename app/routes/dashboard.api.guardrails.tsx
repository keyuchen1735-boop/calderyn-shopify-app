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

  // Mirror the onboarding guard (app/routes/app.onboarding.tsx): a present
  // budget or per-action cap must be a positive number, and cooldown >= 0 —
  // otherwise the patch would silently disable the guardrail. Only validate
  // keys actually in the patch, since this is a partial update.
  const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const nonNegative = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if ("daily_action_budget_cents" in patch && !positive(patch.daily_action_budget_cents)) {
    return jsonError(422, "invalid_guardrails");
  }
  if ("dollar_cap_cents" in patch && !positive(patch.dollar_cap_cents)) {
    return jsonError(422, "invalid_guardrails");
  }
  if ("cooldown_minutes" in patch && !nonNegative(patch.cooldown_minutes)) {
    return jsonError(422, "invalid_guardrails");
  }

  return dashboardJson(async () => ({
    guardrails: await calderynClient(session.shopDomain).guardrails.update(patch),
  }));
}
