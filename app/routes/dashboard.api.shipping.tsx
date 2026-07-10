// GET  → ShippingSummary (read model for the dashboard Shipping screen)
// POST { intent: 'set_rules' | 'set_origin' | 'add_flat_rate' | 'update_flat_rate' | 'delete_flat_rate', ... }
//
// Every write returns the refreshed ShippingSummary so the screen (and its
// session cache) repaints from one authoritative read instead of stitching
// client state. Conventions mirror dashboard.api.ship-cost.tsx: same-origin +
// session + per-shop rate limit, intent-dispatched JSON body.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin, rateLimit } from "~/lib/dashboard/http.server";
import { loadShippingSummary } from "~/lib/shipping/summary.server";
import { saveShipRules } from "~/lib/shipping/rules.server";
import { deleteFlatRate, upsertFlatRate, type FlatRateInput } from "~/lib/shipping/flat-rate.server";
import { saveShopOrigin } from "~/lib/commerce/origin.server";
import { isKnownCountry } from "~/lib/storefront/countries";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadShippingSummary(session.shopId));
}

/** Finite number within [min, max], else null (never NaN into the DB). */
function num(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function parseFlatRateInput(body: Record<string, unknown>): FlatRateInput | null {
  const label = String(body.label ?? "").trim();
  if (!label || label.length > 80) return null;
  const zone = String(body.zone ?? "all");
  if (!["domestic", "international", "all"].includes(zone)) return null;
  // Weight cap arrives in POUNDS (what merchants think in); stored in ounces.
  let maxWeightOz: number | null = null;
  if (body.max_weight_lb != null && body.max_weight_lb !== "") {
    const lb = num(body.max_weight_lb, 0.01, 10_000);
    if (lb == null) return null;
    maxWeightOz = Math.round(lb * 16 * 100) / 100;
  }
  const amount = num(body.amount, 0, 100_000); // dollars
  if (amount == null) return null;
  let estTransitDays: number | null = null;
  if (body.est_days != null && body.est_days !== "") {
    estTransitDays = num(body.est_days, 0, 90);
    if (estTransitDays == null) return null;
    estTransitDays = Math.round(estTransitDays);
  }
  return { label, zone: zone as FlatRateInput["zone"], maxWeightOz, amountCents: Math.round(amount * 100), estTransitDays };
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  if (!(await rateLimit(`shipping-settings:${session.shopId}`, 60, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  const shopId = session.shopId;
  const intent = String(body.intent ?? "");
  // Mutations run INSIDE dashboardJson so a Supabase write failure surfaces through
  // the JSON error envelope (mirrors dashboard.api.ship-cost.tsx), never a bare 500.
  const applyAndRefresh = (mutate: () => Promise<void>) =>
    dashboardJson(async () => {
      await mutate();
      return loadShippingSummary(shopId);
    });

  if (intent === "set_rules") {
    const markupPct = num(body.markup_pct ?? 0, -100, 1000);
    const handling = num(body.handling_fee ?? 0, 0, 10_000); // dollars
    const handlingDays = num(body.handling_days ?? 1, 0, 60);
    if (markupPct == null || handling == null || handlingDays == null) {
      return jsonError(422, "invalid_rules");
    }
    let freeShipThresholdCents: number | null = null;
    if (body.free_ship_threshold != null && body.free_ship_threshold !== "") {
      const threshold = num(body.free_ship_threshold, 0, 1_000_000); // dollars
      if (threshold == null) return jsonError(422, "invalid_threshold");
      freeShipThresholdCents = Math.round(threshold * 100);
    }
    return applyAndRefresh(() =>
      saveShipRules(shopId, {
        markupPct,
        handlingCents: Math.round(handling * 100),
        freeShipThresholdCents,
        handlingDays: Math.round(handlingDays),
      }),
    );
  }

  if (intent === "set_origin") {
    const street1 = String(body.street1 ?? "").trim();
    const street2 = String(body.street2 ?? "").trim();
    const city = String(body.city ?? "").trim();
    const state = String(body.state ?? "").trim();
    const zip = String(body.zip ?? "").trim();
    const country = String(body.country ?? "").trim().toUpperCase();
    if (!street1 || !city || !state || !zip) return jsonError(422, "missing_address_fields");
    if ([street1, street2, city, state, zip].some((v) => v.length > 200)) {
      return jsonError(422, "address_field_too_long");
    }
    if (!isKnownCountry(country)) return jsonError(422, "invalid_country");
    return applyAndRefresh(() =>
      saveShopOrigin(shopId, {
        street1,
        street2: street2 || null,
        city,
        state,
        zip,
        country,
      }),
    );
  }

  if (intent === "add_flat_rate" || intent === "update_flat_rate") {
    const input = parseFlatRateInput(body);
    if (!input) return jsonError(422, "invalid_flat_rate");
    const id = intent === "update_flat_rate" ? String(body.id ?? "").trim() : undefined;
    if (intent === "update_flat_rate" && !id) return jsonError(422, "missing_id");
    return applyAndRefresh(() => upsertFlatRate(shopId, input, id));
  }

  if (intent === "delete_flat_rate") {
    const id = String(body.id ?? "").trim();
    if (!id) return jsonError(422, "missing_id");
    return applyAndRefresh(() => deleteFlatRate(shopId, id));
  }

  return jsonError(422, "invalid_intent");
}
