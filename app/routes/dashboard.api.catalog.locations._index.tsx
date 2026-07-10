import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { createLocation, validateNewLocation } from "~/lib/catalog/locations.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const { data, error } = await getSupabase()
      .from("location_dim")
      .select("id, name, priority, lat, lng, street1, street2, city, region, postal_code, country")
      .eq("shop_id", session.shopId)
      .eq("active", true)
      .order("priority");
    if (error) throw error;
    return {
      locations: (data ?? []).map((l) => ({
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
      })),
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
