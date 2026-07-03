import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, jsonOk, requireSameOrigin } from "~/lib/dashboard/http.server";
import { createTransfer, receiveTransfer } from "~/lib/inventory/engine.server";
import { getSupabase } from "~/lib/supabase.server";

// GET ?variantId= → the shop's in-transit transfers (optionally for one variant),
// so the merchant can receive them. Location ids on inventory_transfer aren't FK'd,
// so names are resolved with a second shop-scoped lookup; variant labels (sku/title,
// for the shop-wide Transfers list) are resolved the same way and are null when the
// variant row is gone or unlabeled.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const variantId = new URL(request.url).searchParams.get("variantId");
  return dashboardJson(async () => {
    let q = getSupabase()
      .from("inventory_transfer")
      .select("id, variant_id, qty, from_location_id, to_location_id, created_at")
      .eq("shop_id", session.shopId)
      .eq("state", "in_transit")
      .order("created_at", { ascending: false });
    if (variantId) q = q.eq("variant_id", variantId);
    const { data, error } = await q;
    if (error) throw error;
    const rows = data ?? [];

    const locIds = [...new Set(rows.flatMap((t) => [String(t.from_location_id), String(t.to_location_id)]))];
    const names = new Map<string, string>();
    if (locIds.length) {
      const { data: locs, error: locErr } = await getSupabase().from("location_dim").select("id, name").eq("shop_id", session.shopId).in("id", locIds);
      if (locErr) throw locErr;
      for (const l of locs ?? []) names.set(String(l.id), String(l.name));
    }

    const varIds = [...new Set(rows.map((t) => String(t.variant_id)))];
    const variants = new Map<string, { sku: string | null; title: string | null }>();
    if (varIds.length) {
      const { data: vs } = await getSupabase().from("variant_dim").select("id, sku, title").eq("shop_id", session.shopId).in("id", varIds);
      for (const v of vs ?? []) {
        variants.set(String(v.id), {
          sku: v.sku == null ? null : String(v.sku),
          title: v.title == null ? null : String(v.title),
        });
      }
    }

    return {
      transfers: rows.map((t) => ({
        id: String(t.id),
        variantId: String(t.variant_id),
        qty: Number(t.qty),
        fromName: names.get(String(t.from_location_id)) ?? "Location",
        toName: names.get(String(t.to_location_id)) ?? "Location",
        createdAt: String(t.created_at),
        sku: variants.get(String(t.variant_id))?.sku ?? null,
        variantTitle: variants.get(String(t.variant_id))?.title ?? null,
      })),
    };
  });
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return jsonError(422, "invalid_json"); }

  try {
    if (body.intent === "receive") {
      const transferId = typeof body.transferId === "string" ? body.transferId : "";
      if (!transferId) return jsonError(422, "missing_transfer");
      await receiveTransfer(session.shopId, transferId);
      return jsonOk({ ok: true });
    }

    const variantId = String(body.variantId ?? ""), from = String(body.fromLocationId ?? ""), to = String(body.toLocationId ?? "");
    const qty = Math.trunc(Number(body.qty) || 0);
    const mode = body.mode === "in_transit" ? "in_transit" : "instant";
    if (!variantId || !from || !to || from === to || qty < 1) return jsonError(422, "invalid_transfer");
    return jsonOk(await createTransfer(session.shopId, variantId, from, to, qty, mode));
  } catch (err) {
    if (err instanceof Error && err.message === "insufficient_stock") {
      return jsonError(422, "insufficient_stock", "Not enough available stock at the source location.");
    }
    console.error("[inventory.api] transfer failed", err);
    return jsonError(500, "internal_error");
  }
}
