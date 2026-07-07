import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { jsonError, jsonOk, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { executeReallocation } from "~/lib/actions/reallocate.server";
import { resolveWeatherAlert } from "~/lib/actions/weather-suggest.server";
import type { SupabaseClient } from "@supabase/supabase-js";

interface ClaimedRow {
  id: string;
  source_campaign_id: string;
  dest_campaign_id: string;
  amount_cents: number;
}

/** Distinguish "no such suggestion for this shop" (404) from "exists but not in a
 * pending state" (409) after an atomic conditional update returned no row. */
async function classifyMiss(
  sb: SupabaseClient,
  suggestionId: string,
  shopId: string,
): Promise<Response> {
  const { data } = await sb
    .from("weather_suggestion")
    .select("id")
    .eq("id", suggestionId)
    .eq("shop_id", shopId)
    .maybeSingle();
  return data ? jsonError(409, "not_actionable") : jsonError(404, "not_found");
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = (await request.json().catch(() => null)) as
    | { suggestionId?: unknown; intent?: unknown }
    | null;
  const suggestionId = typeof body?.suggestionId === "string" ? body.suggestionId : "";
  const intent =
    body?.intent === "apply" || body?.intent === "dismiss" || body?.intent === "arm"
      ? body.intent
      : "";
  if (!suggestionId || !intent) return jsonError(422, "bad_request");

  const sb = getSupabase();

  if (intent === "dismiss" || intent === "arm") {
    // Conditional UPDATE, not read-then-write, so it can't clobber an
    // already-applied row's bookkeeping. Arm only from pending; dismiss from
    // pending OR armed — an armed move must always be cancellable (disarm)
    // right up until it executes. Arming moves no budget: the daily weather
    // cron executes the row when the fresh forecast confirms the trigger.
    const next = intent === "dismiss" ? "dismissed" : "armed";
    const from = intent === "dismiss" ? ["pending", "armed"] : ["pending"];
    const { data, error } = await sb
      .from("weather_suggestion")
      .update({ status: next })
      .eq("id", suggestionId)
      .eq("shop_id", session.shopId)
      .in("status", from)
      .select("id, source_campaign_id, dest_campaign_id")
      .maybeSingle();
    if (error) {
      console.error(`[weather-reallocation] ${intent} failed`, error);
      return jsonError(500, "internal_error");
    }
    if (!data) return classifyMiss(sb, suggestionId, session.shopId);
    if (intent === "dismiss") {
      await resolveWeatherAlert(
        sb,
        session.shopId,
        String(data.source_campaign_id),
        String(data.dest_campaign_id),
      );
    }
    return jsonOk({ ok: true, status: next });
  }

  // Apply. Atomically CLAIM the row (pending → applying) so two concurrent
  // approvals cannot both reach executeReallocation and double-move budget. Only
  // the request that flips the row proceeds; a loser (or a non-pending/unknown
  // row) gets no row back.
  // Apply is allowed from pending (approve now) or armed (fire early rather
  // than wait for the weather trigger).
  const { data: claimedData, error: claimErr } = await sb
    .from("weather_suggestion")
    .update({ status: "applying" })
    .eq("id", suggestionId)
    .eq("shop_id", session.shopId)
    .in("status", ["pending", "armed"])
    .select("id, source_campaign_id, dest_campaign_id, amount_cents")
    .maybeSingle();
  if (claimErr) {
    console.error("[weather-reallocation] claim failed", claimErr);
    return jsonError(500, "internal_error");
  }
  const row = claimedData as ClaimedRow | null;
  if (!row) return classifyMiss(sb, suggestionId, session.shopId);

  const setStatus = (status: string) =>
    sb.from("weather_suggestion").update({ status }).eq("id", row.id).eq("shop_id", session.shopId);

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
    // A throw can land AFTER the budgets were already moved on-platform but
    // BEFORE the idempotency record was written: executeReallocation reduces the
    // source and raises the dest budget first, then insertAuditWithIdempotency
    // can still throw on the action_audit insert. Releasing back to `pending`
    // would let a re-approval move the budget a SECOND time, because
    // priorExecutionForKey finds no record. A post-mutation throw is not safely
    // retryable — mark it terminal 'failed' (matching the outcome==='failed'
    // branch below); a fresh suggestion comes from the next cron run.
    console.error("[weather-reallocation] execute threw", err);
    await setStatus("failed");
    return jsonError(502, "reallocation_failed");
  }

  if (outcome === "failed") {
    // Completed with a permanent failure: the idempotency key is now consumed, so
    // re-approving would only replay the failure. Mark terminal 'failed' (not a
    // misleading 'pending') — a fresh suggestion comes from the next cron run.
    await setStatus("failed");
    return jsonError(502, "reallocation_failed");
  }

  // 'succeeded' or 'retrying' (retry.server.ts drains the in-flight dest step).
  await setStatus("applied");
  await resolveWeatherAlert(sb, session.shopId, row.source_campaign_id, row.dest_campaign_id);
  return jsonOk({ ok: true, status: "applied", outcome });
}
