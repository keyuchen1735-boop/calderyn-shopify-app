// POST { type, idempotency_key, daily_budget_cents? } → shared action pipeline.

import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { executeAction, type ExecutableKind } from "~/lib/actions/execute.server";
import { getSupabase } from "~/lib/supabase.server";

const KINDS: ExecutableKind[] = [
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
];

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

  if (!KINDS.includes(kind)) return jsonError(422, "invalid_action_type");
  if (!idempotencyKey) return jsonError(422, "missing_idempotency_key");
  if (
    (kind === "reduce_campaign_budget" || kind === "increase_campaign_budget") &&
    (!Number.isFinite(dailyBudgetCents) || (dailyBudgetCents as number) <= 0)
  ) {
    return jsonError(422, "invalid_daily_budget_cents");
  }

  const result = await executeAction(
    session.shopId,
    {
      alertId: typeof body.alert_id === "string" ? body.alert_id : null,
      kind,
      campaignId: String(params.id),
      idempotencyKey,
      dailyBudgetCents,
      actor: "merchant:web-dashboard",
    },
    getSupabase(),
  );

  if (result.outcome === "failed") {
    return new Response(
      JSON.stringify({ error: "action_failed", audit_id: result.id, outcome: result.outcome }),
      { status: 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  }

  return dashboardJson(async () => ({ audit_id: result.id, outcome: result.outcome }));
}
