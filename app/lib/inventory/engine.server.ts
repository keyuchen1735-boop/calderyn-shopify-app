// Inventory engine: thin TS wrappers over the inventory SQL functions. Every
// balance mutation -- buyer reserve/commit/release AND merchant adjust /
// mark-unavailable / transfer / receive -- is an atomic, shop-scoped Postgres
// function (FOR UPDATE lock + relative/conditional write), never a read-then-write
// in TS, so a merchant edit can't clobber a concurrent sale. After a mutation that
// changes on_hand/unavailable we project an inventory_level_fact observation so the
// existing engine reads the owned numbers. Keyed by shop_id.
import { getSupabase } from "../supabase.server";
import { orderLocations, type Loc, type Dest } from "./allocate";
import { effectiveLineQuantities } from "../order/line-edits.server";
import { projectLevelFact } from "./project-level-fact.server";

const HOLD_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type Allocation = Array<{ locationId: string; qty: number; backorder?: boolean }>;

// Active locations only: a deactivated location must never appear in the
// allocation order, so a reserve can't land stock movements there.
async function locationOrder(shopId: string, dest: Dest): Promise<string[]> {
  const { data, error } = await getSupabase().from("location_dim").select("id, priority, lat, lng").eq("shop_id", shopId).eq("active", true);
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
  // Surface the SELECT error (rule 12) instead of swallowing it: a transient failure here left the
  // loop empty, so no projectLevelFact ran and inventory_level_fact stayed at its stale pre-sale
  // (higher) available value while the balance had already decremented. Throwing lets the caller
  // retry (commit is idempotent; the reaper isolates each release) so the engine's observation stays
  // consistent with the authoritative balance.
  const { data, error } = await getSupabase().from("inventory_reservation").select("variant_id, location_id").eq("shop_id", shopId).eq("checkout_ref", checkoutRef);
  if (error) throw error;
  const seen = new Set<string>();
  for (const r of data ?? []) {
    const key = `${r.variant_id}:${r.location_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await projectLevelFact(shopId, String(r.variant_id), String(r.location_id));
  }
}

// A new owned shop starts with no location_dim row (locations arrive via import
// or the demo seed), so a dashboard-created product needs one before its stock
// can live in the ledger. Returns the shop's primary ACTIVE location — lowest
// priority, then oldest — creating a default "Primary" one when the shop has
// none (including when every existing location has been deactivated: seeding
// stock into a deactivated location would strand it invisibly).
export async function ensurePrimaryLocation(shopId: string): Promise<string> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("location_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("active", true)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  if (data && data.length) return String(data[0].id);
  const { data: created, error: cErr } = await sb
    .from("location_dim")
    .insert({ shop_id: shopId, name: "Primary", active: true, priority: 0 })
    .select("id")
    .single();
  if (cErr) throw cErr;
  return String(created.id);
}

// Seed a newly created variant's starting on-hand into the owned ledger so the
// cannot-oversell engine (and checkout) can actually reserve against it. The
// product editor writes only the flat variant_dim.inventory_on_hand column;
// without this a "live" product has no balance row and every sale 422s. Idempotent:
// skips zero quantities and any (variant, location) that already has a balance
// row, so a re-save or a later hand-adjusted count is never stomped.
export async function seedInitialStock(shopId: string, variantId: string, onHand: number): Promise<void> {
  const qty = Math.max(0, Math.trunc(onHand));
  if (qty <= 0) return;
  const locationId = await ensurePrimaryLocation(shopId);
  const { data: existing, error } = await getSupabase()
    .from("inventory_balance")
    .select("variant_id")
    .eq("shop_id", shopId)
    .eq("variant_id", variantId)
    .eq("location_id", locationId)
    .limit(1);
  if (error) throw error;
  if (existing && existing.length) return;
  await adjustStock(shopId, variantId, locationId, qty, "initial");
}

// Refund/cancel restock: put a whole order's sold units back into on_hand at the
// shop's primary location. Amount-based Phase-1 refunds have no line selection, so
// this is all-lines-or-nothing (per-line restock arrives with returns). Only
// tracked variants restock (untracked lines never held ledger stock). Idempotent:
// the ledger key restock:<order>:<variant> makes a replayed refund/cancel a no-op.
//
// EFFECTIVE-QUANTITY NETTING (orders phase 3, extended phase 4): quantities are netted through
// effectiveLineQuantities, NOT read raw off the order_line snapshot, AND further netted against
// any COMPLETED (received/closed) return that already restocked some of those units. A line
// reduced via executeReduceLineAction either already put its reduced units back (restockLine, its
// own editrestock:<edit-row-id> ledger key — a DIFFERENT key from restock:<order>:<variant>, so
// idempotency would NOT catch the overlap) or the merchant explicitly chose not to restock
// them at reduction time. Likewise, a completed return line with restock=true already put its
// units back (restockLine, its own restockreturn:<return-line-id> ledger key — again a DIFFERENT
// key, so idempotency would NOT catch this overlap either). Either way, a later whole-order
// restock (cancel / full refund) must return only the units NEITHER a reduction NOR a completed
// return already accounted for, or a reduced-or-returned-then-refunded order would inflate on_hand
// above what was ever actually sold.
//
// PARTIAL-PROGRESS CONTRACT: each variant's inventory_restock RPC commits independently
// (its own atomic Postgres function), so a failure on one variant midway through the loop
// does NOT roll back the variants already restocked before it. Because the ledger key is
// per-(order, variant), and the caller's refund idempotency key short-circuits on replay
// (and, for a full refund, the order is already `refunded`), a later retry can never re-enter
// this function for the same order. Throwing on the first failure would therefore both (a)
// abandon the remaining variants forever and (b) tell the caller "0 restocked" when some
// variants truly were restocked. So we keep going past a failed variant, log every failure
// loudly, and report exactly what happened: how many lines succeeded and which variants
// failed, so the caller can record a truthful, actionable audit trail.
/** Units already put back by a COMPLETED (received/closed) return with restock=true, per
 *  order_line — mirrors returns.server.ts's own COMPLETED_RETURN_STATUSES set (that module isn't
 *  imported here to avoid a cross-module dependency for one literal pair; both must be kept in
 *  sync if the return lifecycle ever grows a new terminal status). An open/cancelled return never
 *  restocked anything, so it contributes nothing here — only received/closed lines count. */
async function completedReturnRestockByLine(
  sb: ReturnType<typeof getSupabase>,
  shopId: string,
  orderId: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const returnsRes = await sb.from("order_return").select("id, status").eq("shop_id", shopId).eq("order_id", orderId);
  if (returnsRes.error) throw returnsRes.error;
  const returnIds = ((returnsRes.data ?? []) as Array<{ id: string; status: string }>)
    .filter((r) => r.status === "received" || r.status === "closed")
    .map((r) => String(r.id));
  if (returnIds.length === 0) return map;
  const linesRes = await sb
    .from("order_return_line")
    .select("order_line_id, quantity, restock")
    .eq("shop_id", shopId)
    .in("return_id", returnIds);
  if (linesRes.error) throw linesRes.error;
  for (const r of (linesRes.data ?? []) as Array<{ order_line_id: string; quantity: number; restock: boolean }>) {
    if (!r.restock) continue;
    const id = String(r.order_line_id);
    map.set(id, (map.get(id) ?? 0) + Number(r.quantity ?? 0));
  }
  return map;
}

export async function restockOrderLines(
  shopId: string, orderId: string, reason: string,
): Promise<{ restockedLines: number; failedVariantIds: string[] }> {
  const sb = getSupabase();
  const { data: lines, error: lErr } = await sb
    .from("order_line")
    .select("id, variant_id, quantity")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (lErr) throw lErr;
  const [effectiveMap, returnRestockByLine] = await Promise.all([
    effectiveLineQuantities(shopId, orderId, sb),
    completedReturnRestockByLine(sb, shopId, orderId),
  ]);
  const byVariant = new Map<string, number>();
  for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
    const v = String(l.variant_id);
    const lineId = String(l.id);
    const effective = effectiveMap.get(lineId)?.effective ?? Number(l.quantity ?? 0);
    const alreadyReturned = returnRestockByLine.get(lineId) ?? 0;
    const qty = Math.max(0, effective - alreadyReturned);
    byVariant.set(v, (byVariant.get(v) ?? 0) + qty);
  }
  if (byVariant.size === 0) return { restockedLines: 0, failedVariantIds: [] };

  const { data: variants, error: vErr } = await sb
    .from("variant_dim")
    .select("id, inventory_tracked")
    .eq("shop_id", shopId)
    .in("id", [...byVariant.keys()]);
  if (vErr) throw vErr;
  const tracked = new Set(
    ((variants ?? []) as Array<Record<string, unknown>>)
      .filter((r) => r.inventory_tracked === true)
      .map((r) => String(r.id)),
  );
  if (tracked.size === 0) return { restockedLines: 0, failedVariantIds: [] };

  const locationId = await ensurePrimaryLocation(shopId);
  let restockedLines = 0;
  const failedVariantIds: string[] = [];
  for (const [variantId, qty] of byVariant) {
    if (!tracked.has(variantId) || qty <= 0) continue;
    const { error } = await sb.rpc("inventory_restock", {
      p_shop_id: shopId, p_variant_id: variantId, p_location_id: locationId,
      p_qty: qty, p_idempotency_key: `restock:${orderId}:${variantId}`, p_reason: reason,
    });
    if (error) {
      // Log loudly and keep going: this variant's RPC did not commit, but earlier variants in
      // this same loop iteration already did (see the partial-progress contract above), so
      // aborting here would silently strand them unreported.
      console.error(
        `[restock] inventory_restock failed for shop ${shopId} order ${orderId} variant ${variantId}:`,
        error,
      );
      failedVariantIds.push(variantId);
      continue;
    }
    await projectLevelFact(shopId, variantId, locationId);
    restockedLines += 1;
  }
  return { restockedLines, failedVariantIds };
}

// Per-line restock for the paid-order line-reduction flow (edit.server.ts): put back ONE line's
// reduced units at the shop's primary location. Distinct from restockOrderLines above (whole-
// order, amount-refund shape) — this is per-variant/qty, keyed by the CALLER's own idempotency
// key rather than a derived `restock:<order>:<variant>` one, because a single order can have
// several independent line reductions for the SAME variant (each needing its own restock, not a
// dedup collision). edit.server.ts derives the key from the order_line_edit row id
// (`editrestock:<edit-row-id>`) — one row, one restock, naturally idempotent on replay. The
// tracked-variant gate lives in the caller (it already has variant_dim loaded for pricing).
export async function restockLine(
  shopId: string,
  orderId: string,
  variantId: string,
  qty: number,
  idempotencyKey: string,
): Promise<void> {
  if (qty <= 0) return;
  const locationId = await ensurePrimaryLocation(shopId);
  const { error } = await getSupabase().rpc("inventory_restock", {
    p_shop_id: shopId,
    p_variant_id: variantId,
    p_location_id: locationId,
    p_qty: qty,
    p_idempotency_key: idempotencyKey,
    p_reason: `line_reduction:${orderId}`,
  });
  if (error) throw error;
  await projectLevelFact(shopId, variantId, locationId);
}

// Paid-without-hold fallback: an order that reached `paid` with NOTHING held in
// inventory_reservation for it (e.g. a variant went tracked=true only after checkout, or a
// reserveStock bug) leaves commitReservation's inventory_commit a silent no-op — flip already-
// held rows to committed finds none, so on_hand never decrements even though the sale genuinely
// happened. This directly decrements via the sale-fallback RPC instead, one call per tracked
// variant on the order, keyed `salefb:<order>:<variant>` so a Stripe redelivery of the same
// event is a no-op. Same read pattern as restockOrderLines: sum order_line by variant, resolve
// the tracked set from variant_dim, skip untracked (untracked lines never held ledger stock).
export async function saleFallbackForOrder(
  shopId: string, orderId: string,
): Promise<{ decremented: number }> {
  const sb = getSupabase();
  const { data: lines, error: lErr } = await sb
    .from("order_line")
    .select("variant_id, quantity")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (lErr) throw lErr;
  const byVariant = new Map<string, number>();
  for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
    const v = String(l.variant_id);
    byVariant.set(v, (byVariant.get(v) ?? 0) + Number(l.quantity ?? 0));
  }
  if (byVariant.size === 0) return { decremented: 0 };

  const { data: variants, error: vErr } = await sb
    .from("variant_dim")
    .select("id, inventory_tracked")
    .eq("shop_id", shopId)
    .in("id", [...byVariant.keys()]);
  if (vErr) throw vErr;
  const tracked = new Set(
    ((variants ?? []) as Array<Record<string, unknown>>)
      .filter((r) => r.inventory_tracked === true)
      .map((r) => String(r.id)),
  );
  if (tracked.size === 0) return { decremented: 0 };

  const locationId = await ensurePrimaryLocation(shopId);
  let decremented = 0;
  for (const [variantId, qty] of byVariant) {
    if (!tracked.has(variantId) || qty <= 0) continue;
    const { error } = await sb.rpc("inventory_sale_fallback", {
      p_shop_id: shopId, p_variant_id: variantId, p_location_id: locationId,
      p_qty: qty, p_idempotency_key: `salefb:${orderId}:${variantId}`,
    });
    if (error) throw error;
    await projectLevelFact(shopId, variantId, locationId);
    decremented += qty;
  }
  return { decremented };
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
