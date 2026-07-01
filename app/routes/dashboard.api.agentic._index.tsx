import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const sb = getSupabase();
    const shopId = session.shopId;

    const clientsRes = await sb
      .from("mcp_oauth_clients")
      .select("client_name, spend_cap_cents")
      .eq("commerce_scope", true);
    if (clientsRes.error) throw clientsRes.error;

    const quotesRes = await sb
      .from("commerce_quote_fact")
      .select("*", { count: "exact", head: true })
      .eq("shop_id", shopId);
    if (quotesRes.error) throw quotesRes.error;

    const ordersRes = await sb
      .from("orders")
      .select("id, total_cents, currency, protocol, state, created_at")
      .eq("shop_id", shopId)
      .eq("channel", "agentic");
    if (ordersRes.error) throw ordersRes.error;

    const orders = (ordersRes.data ?? []) as Array<Record<string, unknown>>;
    return {
      clients: (clientsRes.data ?? []).map((c: Record<string, unknown>) => ({
        name: String(c.client_name),
        spendCapCents: Number(c.spend_cap_cents ?? 0),
      })),
      quotesIssued: quotesRes.count ?? 0,
      orders: orders.map((o) => ({
        id: String(o.id),
        totalCents: Number(o.total_cents),
        currency: String(o.currency),
        protocol: o.protocol ? String(o.protocol) : null,
        state: String(o.state),
        createdAt: String(o.created_at),
      })),
      ordersCount: orders.length,
      revenueCents: orders
        .filter((o) => o.state === "paid")
        .reduce((s, o) => s + Number(o.total_cents), 0),
    };
  });
}
