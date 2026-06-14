// Snooze = a timed deferral of an open alert. Unlike acknowledge (which closes
// the alert), snooze hides it temporarily and lets it re-surface on whichever
// comes first: the 1-day cap, or the merchant's next login.
//
// Storage: alerts.status -> 'snoozed' + alerts.snoozed_until (timestamptz).
// v_alerts_view excludes rows that are still snoozed (snoozed_until > now), so a
// snoozed alert simply disappears from every list until it re-surfaces.
//
// Re-surfacing:
//   - The +1-day cap is a *display* concern: v_alerts_view shows a snooze whose
//     snoozed_until has passed as 'open' again, so it re-appears with no write.
//   - resurfaceAllSnoozes is the "next login" trigger. Called when a fresh
//     session is established (dashboard createSession / embedded afterAuth), so
//     no snooze survives a login boundary.

import type { SupabaseClient } from "@supabase/supabase-js";

/** A snooze defers an alert for one day, capped by the merchant's next login. */
export const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Defer an alert: status -> snoozed, with a deadline 1 day out. Guarded on
 * status in ('open','snoozed') so it (re)snoozes an open alert OR re-hides one
 * that already re-surfaced via the +1-day cap — but never touches a resolved or
 * acknowledged alert. Returns false (and logs) on failure so the caller can
 * surface it without failing the recorded action.
 */
export async function snoozeAlert(
  sb: SupabaseClient,
  shopId: string,
  alertId: string,
): Promise<boolean> {
  try {
    const snoozedUntil = new Date(Date.now() + SNOOZE_DURATION_MS).toISOString();
    const { error } = await sb
      .from("alerts")
      .update({ status: "snoozed", snoozed_until: snoozedUntil })
      .eq("shop_id", shopId)
      .eq("id", alertId)
      .in("status", ["open", "snoozed"]);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[alerts] failed to snooze ${alertId}`, err);
    return false;
  }
}

/**
 * The "next login" trigger: flip every snoozed alert for the shop back to
 * 'open', regardless of deadline. Called when a fresh session is established so
 * snoozes never survive a login boundary.
 */
export async function resurfaceAllSnoozes(
  sb: SupabaseClient,
  shopId: string,
): Promise<boolean> {
  try {
    const { error } = await sb
      .from("alerts")
      .update({ status: "open", snoozed_until: null })
      .eq("shop_id", shopId)
      .eq("status", "snoozed");
    if (error) throw error;
    return true;
  } catch (err) {
    console.error(`[alerts] failed to re-surface snoozes for ${shopId}`, err);
    return false;
  }
}
