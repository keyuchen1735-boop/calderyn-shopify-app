import type { LoaderFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const { data, error } = await getSupabase()
      .from("location_dim")
      .select("id, name, priority, lat, lng")
      .eq("shop_id", session.shopId)
      .order("priority");
    if (error) throw error;
    return { locations: data ?? [] };
  });
}
