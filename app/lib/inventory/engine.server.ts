// Inventory engine: thin TS wrappers over the inventory SQL functions. Every
// balance mutation -- buyer reserve/commit/release AND merchant adjust /
// mark-unavailable / transfer / receive -- is an atomic, shop-scoped Postgres
// function (FOR UPDATE lock + relative/conditional write), never a read-then-write
// in TS, so a merchant edit can't clobber a concurrent sale. After a mutation that
// changes on_hand/unavailable we project an inventory_level_fact observation so the
// existing engine reads the owned numbers. Keyed by shop_id.
import { getSupabase } from "../supabase.server";
import { orderLocations, type Loc, type Dest } from "./allocate";
import { projectLevelFact } from "./project-level-fact.server";

const HOLD_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type Allocation = Array<{ locationId: string; qty: number; backorder?: boolean }>;

async function locationOrder(shopId: string, dest: Dest): Promise<string[]> {
  const { data, error } = await getSupabase().from("location_dim").select("id, priority, lat, lng").eq("shop_id", shopId);
  if (error) throw error;
  const locs: Loc[] = (data ?? []).map((l: Record<string, unknown>) => ({
    id: String(l.id), priority: Number(l.priority ?? 0),
    lat: l.lat == null ? null : Number(l.lat), lng: l.lng == null ? null : Number(l.lng),
  }));
  return orderLocations(locs, dest);
}

export async function reserveStock(
  shopId: string, variantId: string, qty: number, checkoutRef: string, dest: Dest = null,
): Promise<{ ok: true; allocation: Allocation } | { ok: false; reason: "insufficient_stock" }> {
  const orderedLocationIds = await locationOrder(shopId, dest);
  const { data, error } = await getSupabase().rpc("inventory_reserve", {
    p_shop_id: shopId, p_variant_id: variantId, p_qty: qty, p_location_ids: orderedLocationIds,
    p_checkout_ref: checkoutRef, p_expires_at: new Date(Date.now() + HOLD_TTL_MS).toISOString(),
    p_idempotency_key: checkoutRef, p_allow_backorder: false,
  });
  if (error) {
    if (String(error.message).includes("insufficient_stock")) return { ok: false, reason: "insufficient_stock" };
    throw error;
  }
  return data as { ok: true; allocation: Allocation };
}

export async function commitReservation(shopId: string, checkoutRef: string): Promise<void> {
  const { error } = await getSupabase().rpc("inventory_commit", { p_shop_id: shopId, p_checkout_ref: checkoutRef });
  if (error) throw error;
  await reprojectCheckout(shopId, checkoutRef);
}

export async function releaseReservation(shopId: string, checkoutRef: string): Promise<void> {
  const { error } = await getSupabase().rpc("inventory_release", { p_shop_id: shopId, p_checkout_ref: checkoutRef });
  if (error) throw error;
  await reprojectCheckout(shopId, checkoutRef);
}

// commit changes on_hand; re-project each touched (variant, location). release
// only touches reserved, so its re-projection is a harmless no-op refresh.
async function reprojectCheckout(shopId: string, checkoutRef: string): Promise<void> {
  const { data } = await getSupabase().from("inventory_reservation").select("variant_id, location_id").eq("shop_id", shopId).eq("checkout_ref", checkoutRef);
  const seen = new Set<string>();
  for (const r of data ?? []) {
    const key = `${r.variant_id}:${r.location_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await projectLevelFact(shopId, String(r.variant_id), String(r.location_id));
  }
}

export async function adjustStock(shopId: string, variantId: string, locationId: string, newOnHand: number, reason?: string): Promise<void> {
  const { error } = await getSupabase().rpc("inventory_adjust", {
    p_shop_id: shopId, p_variant_id: variantId, p_location_id: locationId,
    p_new_on_hand: Math.max(0, Math.trunc(newOnHand)), p_reason: reason ?? null,
  });
  if (error) throw error;
  await projectLevelFact(shopId, variantId, locationId);
}

export async function markUnavailable(shopId: string, variantId: string, locationId: string, qty: number, reason: string): Promise<void> {
  const { error } = await getSupabase().rpc("inventory_mark_unavailable", {
    p_shop_id: shopId, p_variant_id: variantId, p_location_id: locationId, p_qty: qty, p_reason: reason,
  });
  if (error) {
    const msg = String(error.message);
    if (msg.includes("insufficient_available")) throw new Error("insufficient_available");
    if (msg.includes("no_balance_row")) throw new Error("no_balance_row");
    throw error;
  }
  await projectLevelFact(shopId, variantId, locationId);
}

export async function createTransfer(
  shopId: string, variantId: string, fromLocationId: string, toLocationId: string, qty: number, mode: "instant" | "in_transit",
): Promise<{ transferId: string }> {
  const { data, error } = await getSupabase().rpc("inventory_create_transfer", {
    p_shop_id: shopId, p_variant_id: variantId, p_from_location_id: fromLocationId,
    p_to_location_id: toLocationId, p_qty: qty, p_mode: mode,
  });
  if (error) {
    if (String(error.message).includes("insufficient_stock")) throw new Error("insufficient_stock");
    throw error;
  }
  await projectLevelFact(shopId, variantId, fromLocationId);
  if (mode === "instant") await projectLevelFact(shopId, variantId, toLocationId);
  return { transferId: String(data) };
}

export async function receiveTransfer(shopId: string, transferId: string): Promise<void> {
  const { data, error } = await getSupabase().rpc("inventory_receive_transfer", { p_shop_id: shopId, p_transfer_id: transferId });
  if (error) throw error;
  if (data && typeof data === "object") {
    const r = data as { variantId?: string; toLocationId?: string };
    if (r.variantId && r.toLocationId) await projectLevelFact(shopId, String(r.variantId), String(r.toLocationId));
  }
}

// --- merchant reads (Plan B) ------------------------------------------------

export interface VariantBalance {
  locationId: string; locationName: string;
  onHand: number; reserved: number; incoming: number; available: number; reorderPoint: number | null;
}

export async function getVariantBalances(shopId: string, variantId: string): Promise<VariantBalance[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("inventory_balance")
    .select("location_id, on_hand, reserved, incoming, available, reorder_point, location:location_dim(name)")
    .eq("shop_id", shopId)
    .eq("variant_id", variantId);
  if (error) throw error;
  return (data ?? []).map((r: Record<string, unknown>) => ({
    locationId: String(r.location_id),
    locationName: String((r.location as { name?: string } | null)?.name ?? "Location"),
    onHand: Number(r.on_hand ?? 0), reserved: Number(r.reserved ?? 0), incoming: Number(r.incoming ?? 0),
    available: Number(r.available ?? 0), reorderPoint: r.reorder_point == null ? null : Number(r.reorder_point),
  }));
}

// Reorder point is a low-stock threshold, not a stock quantity (no oversell risk),
// so it stays a simple shop-scoped update rather than an atomic function.
export async function setReorderPoint(shopId: string, variantId: string, locationId: string, reorderPoint: number | null): Promise<void> {
  const { error } = await getSupabase().from("inventory_balance")
    .update({ reorder_point: reorderPoint, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId).eq("variant_id", variantId).eq("location_id", locationId);
  if (error) throw error;
}
