import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { createLocation, validateNewLocation } from "~/lib/catalog/locations.server";

// GET returns the shop's active locations; `?includeInactive=1` adds an
// `inactive` array (same field mapping) so the settings screen can offer
// reactivation. The default shape stays `{ locations }` for existing consumers.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const includeInactive = new URL(request.url).searchParams.get("includeInactive") === "1";
  return dashboardJson(async () => {
    let q = getSupabase()
      .from("location_dim")
      .select("id, name, priority, lat, lng, street1, street2, city, region, postal_code, country, active")
      .eq("shop_id", session.shopId);
    if (!includeInactive) q = q.eq("active", true);
    const { data, error } = await q.order("priority");
    if (error) throw error;
    const mapRow = (l: NonNullable<typeof data>[number]) => ({
      id: l.id,
      name: l.name,
      priority: l.priority,
      lat: l.lat,
      lng: l.lng,
      street1: l.street1 ?? undefined,
      street2: l.street2 ?? undefined,
      city: l.city ?? undefined,
      region: l.region ?? undefined,
      postalCode: l.postal_code ?? undefined,
      country: l.country ?? undefined,
    });
    const rows = data ?? [];
    if (!includeInactive) return { locations: rows.map(mapRow) };
    return {
      locations: rows.filter((l) => l.active !== false).map(mapRow),
      inactive: rows.filter((l) => l.active === false).map(mapRow),
    };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = await parseJsonObjectBody(request);
  if (body === null) return jsonError(400, "bad_body");
  const parsed = validateNewLocation(body);
  if (!parsed.ok) {
    return jsonError(422, parsed.code, "Give the location a name (up to 120 characters).");
  }

  return dashboardJson(() => createLocation(session.shopId, parsed.value));
}
