// Reservation reaper: frees holds whose TTL has lapsed (abandoned checkouts).
// Each distinct (shop, checkout_ref) is released once via the engine, which
// reverses the reserved bump and re-projects inventory_level_fact.
import { getSupabase } from "../supabase.server";
import { releaseReservation } from "./engine.server";

export async function expireStaleReservations(): Promise<{ released: number; failed: number }> {
  const { data, error } = await getSupabase()
    .from("inventory_reservation")
    .select("shop_id, checkout_ref")
    .eq("state", "held")
    .lt("expires_at", new Date().toISOString());
  if (error) throw error;
  const seen = new Set<string>();
  let released = 0;
  let failed = 0;
  for (const r of data ?? []) {
    const key = `${r.shop_id}:${r.checkout_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Isolate each release. Without this, one failing (shop, checkout_ref) — a transient release
    // RPC / projection error — throws out of the loop and SKIPS every remaining stale hold in the
    // run (across all shops), keeping their units reserved and their variants falsely out of stock.
    // Log + continue instead; a transient failure self-heals on the next run since the row stays
    // state='held'. The cron still 200s with a released/failed count for visibility (rule 12).
    try {
      await releaseReservation(String(r.shop_id), String(r.checkout_ref));
      released++;
    } catch (err) {
      failed++;
      console.error(
        `[reaper] failed to release stale hold (shop ${r.shop_id}, checkout ${r.checkout_ref}); continuing:`,
        err,
      );
    }
  }
  return { released, failed };
}
