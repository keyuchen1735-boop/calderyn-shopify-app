import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonError, jsonOk, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { executeReallocation } from "~/lib/actions/reallocate.server";

interface SuggestionRow {
  id: string;
  status: string;
  source_campaign_id: string;
  dest_campaign_id: string;
  amount_cents: number;
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = (await request.json().catch(() => null)) as
    | { suggestionId?: unknown; intent?: unknown }
    | null;
  const suggestionId = typeof body?.suggestionId === "string" ? body.suggestionId : "";
  const intent = body?.intent === "apply" || body?.intent === "dismiss" ? body.intent : "";
  if (!suggestionId || !intent) return jsonError(422, "bad_request");

  const sb = getSupabase();
  const { data, error } = await sb
    .from("weather_suggestion")
    .select("id, status, source_campaign_id, dest_campaign_id, amount_cents")
    .eq("id", suggestionId)
    .eq("shop_id", session.shopId)
    .maybeSingle();
  if (error) {
    console.error("[weather-reallocation] load failed", error);
    return jsonError(500, "internal_error");
  }
  const row = data as SuggestionRow | null;
  if (!row) return jsonError(404, "not_found");

  if (intent === "dismiss") {
    await sb.from("weather_suggestion").update({ status: "dismissed" }).eq("id", row.id).eq("shop_id", session.shopId);
    return jsonOk({ ok: true, status: "dismissed" });
  }

  if (row.status !== "pending") return jsonError(409, "not_pending");

  // Mirrors app.campaigns._index.tsx: human-approved → NO checkGuardrails (those
  // caps require autopilot_enabled). executeReallocation re-validates ownership
  // and that the move leaves the source budget positive.
  let outcome: string;
  try {
    const res = await executeReallocation(
      session.shopId,
      {
        alertId: null,
        sourceCampaignId: row.source_campaign_id,
        destCampaignId: row.dest_campaign_id,
        amountCents: row.amount_cents,
        idempotencyKey: `weather:${row.id}`,
        actor: "merchant",
        triggerReason: "weather",
      },
      sb,
    );
    outcome = res.outcome;
  } catch (err) {
    console.error("[weather-reallocation] execute failed", err);
    return jsonError(502, "reallocation_failed");
  }
  if (outcome === "failed") return jsonError(502, "reallocation_failed");

  await sb.from("weather_suggestion").update({ status: "applied" }).eq("id", row.id).eq("shop_id", session.shopId);
  return jsonOk({ ok: true, status: "applied", outcome });
}
