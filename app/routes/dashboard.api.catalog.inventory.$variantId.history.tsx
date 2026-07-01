import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const { data, error } = await getSupabase()
      .from("inventory_ledger")
      .select("id, location_id, entry_type, qty, reason, created_at")
      .eq("shop_id", session.shopId)
      .eq("variant_id", String(params.variantId))
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return { history: data ?? [] };
  });
}
