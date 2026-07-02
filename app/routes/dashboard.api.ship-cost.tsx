// GET  → { ship_mode, missing_weight_pct }
// POST { intent: 'set_mode' | 'add_period_total' | 'set_manual_override', ... }
//
// Dashboard mirror of the ship-cost inputs on app.settings.tsx. Reuses the
// stack-agnostic inputs.server helpers; sb + shopId are resolved directly like
// the other dashboard action routes (skus.$id.relocate, alerts.$id.action).
// CSV invoice upload stays embedded-admin-only for now (multipart from the
// dashboard fetch client is a follow-up); typed total + mode + override + the
// missing-weight nudge are mirrored here.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin, rateLimit } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { saveTypedPeriodTotal, setManualOverride } from "~/lib/ship-cost/inputs.server";
import { missingWeightPct } from "~/lib/ship-cost/missing-weight";

const MODES = ["auto", "force_measured", "force_reconciled"];

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const sb = getSupabase();
  return dashboardJson(async () => {
    const [{ data: settingsRow }, { data: orderRows }] = await Promise.all([
      sb.from("shop_settings").select("ship_cost_mode").eq("shop_id", session.shopId).maybeSingle(),
      sb.from("v_order_ship_features").select("grams_sum").eq("shop_id", session.shopId),
    ]);
    return {
      ship_mode: (settingsRow?.ship_cost_mode as string | null) ?? "auto",
      missing_weight_pct: missingWeightPct(
        ((orderRows ?? []) as { grams_sum: number | null }[]).map((o) => ({
          gramsSum: o.grams_sum ?? null,
        })),
      ),
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
      await sb.from("shop_settings").upsert({
        shop_id: shopId,
        ship_cost_mode: mode,
        updated_at: new Date().toISOString(),
      });
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
