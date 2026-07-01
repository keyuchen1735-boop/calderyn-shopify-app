// Reservation reaper: frees holds whose TTL has lapsed (abandoned checkouts).
// Each distinct (shop, checkout_ref) is released once via the engine, which
// reverses the reserved bump and re-projects inventory_level_fact.
import { getSupabase } from "../supabase.server";
import { releaseReservation } from "./engine.server";

export async function expireStaleReservations(): Promise<{ released: number }> {
  const { data, error } = await getSupabase()
    .from("inventory_reservation")
    .select("shop_id, checkout_ref")
    .eq("state", "held")
    .lt("expires_at", new Date().toISOString());
  if (error) throw error;
  const seen = new Set<string>();
  for (const r of data ?? []) {
    const key = `${r.shop_id}:${r.checkout_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await releaseReservation(String(r.shop_id), String(r.checkout_ref));
  }
  return { released: seen.size };
}
