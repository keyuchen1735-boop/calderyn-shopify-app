// Saved order-list views (Phase 2 Task 2): direct Supabase CRUD against `order_view`
// (shop-scoped, RLS'd — see the 20260710090000_orders_list_unified.sql migration), kept out of
// the route so the create-limit + name-conflict logic is unit-testable without a Request/Response.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";

/** Same ceiling the migration doesn't enforce in SQL — checked here so a shop can't quietly
 *  accumulate an unbounded number of saved views. */
export const MAX_ORDER_VIEWS = 20;

export interface OrderViewRow {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  position: number;
}

/** Thrown by createOrderView when the shop already has MAX_ORDER_VIEWS saved views. */
export class TooManyViewsError extends Error {
  constructor() {
    super(`A shop may not have more than ${MAX_ORDER_VIEWS} saved views.`);
    this.name = "TooManyViewsError";
  }
}

/** Thrown by createOrderView on the (shop_id, name) unique-constraint violation. */
export class ViewNameTakenError extends Error {
  constructor() {
    super("A saved view with this name already exists.");
    this.name = "ViewNameTakenError";
  }
}

function mapRow(row: Record<string, unknown>): OrderViewRow {
  return {
    id: String(row.id),
    name: String(row.name),
    filters: (row.filters ?? {}) as Record<string, unknown>,
    position: Number(row.position ?? 0),
  };
}

/** List a shop's saved views, ordered by position then created_at (stable manual/insertion order). */
export async function listOrderViews(
  shopId: string,
  sb: SupabaseClient = getSupabase(),
): Promise<OrderViewRow[]> {
  const { data, error } = await sb
    .from("order_view")
    .select("id, name, filters, position")
    .eq("shop_id", shopId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`order_view read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(mapRow);
}

/**
 * Create a saved view. Enforces MAX_ORDER_VIEWS (checked here, not in SQL) and surfaces the
 * (shop_id, name) unique-constraint violation (Postgres 23505) as ViewNameTakenError instead of
 * an opaque 500 — the same 23505-to-typed-error convention as tenant.server.ts / catalog.server.ts.
 *
 * NOTE: The MAX_ORDER_VIEWS check is a SOFT cap. Concurrent creates at or near the limit can
 * briefly exceed it by one or two due to the non-atomic check-then-insert pattern. This is
 * cosmetic (views are UI display shortcuts) and acceptable; the hard guarantee is the unique
 * (shop_id, name) constraint in the database. Folding the count check into DB-side triggers is
 * deliberately deferred.
 */
export async function createOrderView(
  shopId: string,
  name: string,
  filters: Record<string, unknown>,
  sb: SupabaseClient = getSupabase(),
): Promise<OrderViewRow> {
  const { data: existing, error: countError } = await sb
    .from("order_view")
    .select("id")
    .eq("shop_id", shopId);
  if (countError) throw new Error(`order_view count read failed: ${countError.message}`);
  if (((existing ?? []) as unknown[]).length >= MAX_ORDER_VIEWS) throw new TooManyViewsError();

  const { data, error } = await sb
    .from("order_view")
    .insert({ shop_id: shopId, name, filters })
    .select("id, name, filters, position")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new ViewNameTakenError();
    throw new Error(`order_view insert failed: ${error.message}`);
  }
  return mapRow(data as Record<string, unknown>);
}

/** Shop-scoped delete. Returns true when a row was actually deleted, false when no row matched
 *  (unknown id or one belonging to another shop) so the route can 404 instead of always 200ing. */
export async function deleteOrderView(
  shopId: string,
  id: string,
  sb: SupabaseClient = getSupabase(),
): Promise<boolean> {
  const { data, error } = await sb
    .from("order_view")
    .delete()
    .eq("shop_id", shopId)
    .eq("id", id)
    .select("id");
  if (error) throw new Error(`order_view delete failed: ${error.message}`);
  return ((data ?? []) as unknown[]).length > 0;
}
