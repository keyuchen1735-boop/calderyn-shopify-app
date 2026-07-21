import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { undoAction } from "~/lib/actions/undo.server";
import { getSupabase } from "~/lib/supabase.server";
import type { AdminGraphqlClient } from "~/lib/shopify/inventory.server";
import { unauthenticated } from "~/shopify.server";

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  return dashboardJson(async () => {
    const sb = getSupabase();
    // Read the forward action's target before resolving Shopify. Native-owned
    // reversals must stay entirely inside Calderyn; only legacy store writes need
    // an Admin client. `undoAction` repeats the scoped read as its authorization
    // and replay boundary, so a missing/changed row still fails loudly there.
    const { data: original, error } = await sb
      .from("action_audit")
      .select("action_kind, params")
      .eq("shop_id", session.shopId)
      .eq("id", String(params.id))
      .maybeSingle();
    if (error) throw error;
    const actionKind = String((original as { action_kind?: unknown } | null)?.action_kind ?? "");
    const actionParams = ((original as { params?: unknown } | null)?.params ?? {}) as { owned?: boolean };
    const needsShopifyAdmin =
      !actionParams.owned &&
      (actionKind === "reallocate_inventory" ||
        actionKind === "adjust_price" ||
        actionKind === "discontinue_sku");

    let admin: AdminGraphqlClient | undefined;
    if (needsShopifyAdmin && session.shopDomain) {
      try {
        ({ admin } = await unauthenticated.admin(session.shopDomain));
      } catch (err) {
        console.error("[undo] unauthenticated.admin failed — proceeding without Shopify admin client", err);
        admin = undefined;
      }
    }
    const result = await undoAction(session.shopId, String(params.id), sb, { admin });
    return { audit_id: result.id };
  });
}
