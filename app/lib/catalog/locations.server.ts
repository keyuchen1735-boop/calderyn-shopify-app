import type { SupabaseClient } from "@supabase/supabase-js";
import { CalderynError } from "../calderyn.server";
import { getSupabase } from "../supabase.server";

export type NewLocationResult =
  | { ok: true; value: { name: string; priority: number } }
  | { ok: false; code: "missing_name" };

/**
 * Validate a create-location request body: `name` must be a non-blank string of
 * at most 120 characters after trimming; `priority` coerces to a truncated
 * integer and defaults to 0 when absent or non-numeric. Pure so the rule is
 * unit-testable without a database.
 */
export function validateNewLocation(raw: unknown): NewLocationResult {
  const body = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) return { ok: false, code: "missing_name" };
  const priority = Math.trunc(Number(body.priority)) || 0;
  return { ok: true, value: { name, priority } };
}

export async function createLocation(
  shopId: string,
  input: { name: string; priority: number },
): Promise<{ id: string }> {
  const { data, error } = await getSupabase()
    .from("location_dim")
    .insert({ shop_id: shopId, name: input.name, priority: input.priority, active: true })
    .select("id")
    .single();
  if (error) throw error;
  return { id: String(data.id) };
}

/**
 * Deactivate a location, refusing while ANY balance row there still holds
 * units (on hand, reserved, or incoming): deactivating a stocked location
 * would strand real inventory in a place the allocator and every picker no
 * longer see. The merchant must move or zero out stock first.
 */
export async function deactivateLocation(shopId: string, locationId: string): Promise<void> {
  const sb = getSupabase();
  const { data: stocked, error: stockErr } = await sb
    .from("inventory_balance")
    .select("variant_id")
    .eq("shop_id", shopId)
    .eq("location_id", locationId)
    .or("on_hand.gt.0,reserved.gt.0,incoming.gt.0")
    .limit(1);
  if (stockErr) throw stockErr;
  if (stocked && stocked.length) {
    throw new CalderynError({
      status: 409,
      code: "location_has_stock",
      message: "Move or zero out stock at this location first.",
    });
  }
  const { error } = await sb
    .from("location_dim")
    .update({ active: false })
    .eq("shop_id", shopId)
    .eq("id", locationId);
  if (error) throw error;
}

export interface LocationPatch {
  priority?: number;
  lat?: number | null;
  lng?: number | null;
  street1?: string;
  street2?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}

export async function updateLocationDetails(
  sb: SupabaseClient,
  shopId: string,
  locationId: string,
  patch: LocationPatch,
): Promise<void> {
  const { error } = await sb
    .from("location_dim")
    .update(patch)
    .eq("shop_id", shopId)
    .eq("id", locationId);
  if (error) throw error;
}
