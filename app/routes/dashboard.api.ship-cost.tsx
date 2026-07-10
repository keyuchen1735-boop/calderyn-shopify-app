// GET  → { ship_mode, missing_weight_pct }
// POST { intent: 'set_mode' | 'add_period_total' | 'set_manual_override', ... }
//
// Dashboard mirror of the ship-cost inputs on app.settings.tsx. Reuses the
// stack-agnostic inputs.server helpers; sb + shopId are resolved directly like
// the other dashboard action routes (skus.$id.relocate, alerts.$id.action).
// CSV invoice upload stays embedded-admin-only for now (multipart from the
// dashboard fetch client is a follow-up); typed total + mode + override + the
// missing-weight nudge are mirrored here.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin, rateLimit } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { saveTypedPeriodTotal, setManualOverride, setShipCostMode, SHIP_COST_MODES } from "~/lib/ship-cost/inputs.server";

const MODES: readonly string[] = SHIP_COST_MODES;

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const sb = getSupabase();
  return dashboardJson(async () => {
    // Count over the FULL order history, not a PostgREST-clamped 1000-row slice:
    // a large shop's missing-weight % was computed from an arbitrary subset. HEAD
    // count queries aggregate server-side and are not row-capped. "Missing" mirrors
    // missingWeightPct: grams_sum IS NULL OR <= 0.
    const [{ data: settingsRow }, { count: total }, { count: missing }] = await Promise.all([
      sb.from("shop_settings").select("ship_cost_mode").eq("shop_id", session.shopId).maybeSingle(),
      sb.from("v_order_ship_features").select("*", { count: "exact", head: true }).eq("shop_id", session.shopId),
      sb
        .from("v_order_ship_features")
        .select("*", { count: "exact", head: true })
        .eq("shop_id", session.shopId)
        .or("grams_sum.is.null,grams_sum.lte.0"),
    ]);
    const totalN = total ?? 0;
    return {
      ship_mode: (settingsRow?.ship_cost_mode as string | null) ?? "auto",
      missing_weight_pct: totalN > 0 ? Math.round(((missing ?? 0) / totalN) * 100) : 0,
    };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  // Defense-in-depth cap on this mutation surface, keyed per shop (the session
  // is already the trust boundary; this bounds a runaway/abusive client).
  if (!(await rateLimit(`ship-cost:${session.shopId}`, 60, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const sb = getSupabase();
  const shopId = session.shopId;
  const intent = String(body.intent ?? "");

  if (intent === "set_mode") {
    const mode = String(body.ship_cost_mode ?? "");
    if (!MODES.includes(mode)) return jsonError(422, "invalid_mode");
    return dashboardJson(async () => {
      await setShipCostMode(sb, shopId, mode as (typeof SHIP_COST_MODES)[number]);
      return { ship_mode: mode };
    });
  }

  if (intent === "add_period_total") {
    const amount = Number(body.amount);
    const carrier = body.carrier ? String(body.carrier).trim() || null : null;
    const periodStart = String(body.period_start ?? "").trim();
    const periodEnd = String(body.period_end ?? "").trim();
    if (!Number.isFinite(amount) || amount <= 0) return jsonError(422, "invalid_amount");
    if (!periodStart || !periodEnd) return jsonError(422, "invalid_period");
    return dashboardJson(async () => {
      await saveTypedPeriodTotal(sb, shopId, {
        totalCents: Math.round(amount * 100),
        carrier,
        periodStart,
        periodEnd,
        shopCountry: null,
      });
      return { ok: true };
    });
  }

  if (intent === "set_manual_override") {
    const orderId = String(body.order_id ?? "").trim();
    if (!orderId) return jsonError(422, "missing_order_id");
    const raw = body.amount;
    let cents: number | null = null;
    if (raw !== "" && raw != null) {
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0) return jsonError(422, "invalid_amount");
      cents = Math.round(amount * 100);
    }
    return dashboardJson(async () => {
      await setManualOverride(sb, shopId, { orderId, cents, shopCountry: null });
      return { ok: true };
    });
  }

  return jsonError(422, "invalid_intent");
}
