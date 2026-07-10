import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { deactivateLocation, updateLocationDetails, type LocationPatch } from "~/lib/catalog/locations.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "PUT") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return jsonError(422, "invalid_json"); }

  // Deactivation is its own request: any other patch keys sent alongside
  // `active: false` are ignored. The stock guard inside deactivateLocation
  // surfaces as a 409 through dashboardJson's CalderynError mapping.
  if (body.active === false) {
    return dashboardJson(async () => {
      await deactivateLocation(session.shopId, String(params.id));
      return { ok: true };
    });
  }

  const patch: LocationPatch = {};
  if (Number.isFinite(body.priority)) patch.priority = Math.trunc(Number(body.priority));
  if (body.lat === null || Number.isFinite(body.lat)) patch.lat = body.lat === null ? null : Number(body.lat);
  if (body.lng === null || Number.isFinite(body.lng)) patch.lng = body.lng === null ? null : Number(body.lng);
  if (typeof body.street1 === "string") patch.street1 = body.street1;
  if (typeof body.street2 === "string") patch.street2 = body.street2;
  if (typeof body.city === "string") patch.city = body.city;
  if (typeof body.region === "string") patch.region = body.region;
  if (typeof body.postalCode === "string") patch.postal_code = body.postalCode;
  if (typeof body.country === "string") patch.country = body.country;
  if (Object.keys(patch).length === 0) return jsonError(422, "empty_patch");

  return dashboardJson(async () => {
    await updateLocationDetails(getSupabase(), session.shopId, String(params.id), patch);
    return { ok: true };
  });
}
