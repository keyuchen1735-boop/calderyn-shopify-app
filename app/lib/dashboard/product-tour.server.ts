import { getSupabase } from "../supabase.server";
import type { ProductTourOutcome } from "./product-tour";

export interface ProductTourState {
  pending: boolean;
  available: boolean;
}

/**
 * Reads the account-level tour state without making the dashboard dependent on
 * a successful preference read. During a rolling deploy the app can arrive a
 * few seconds before the migration; in that case the tour stays hidden while
 * the rest of the dashboard remains available.
 */
export async function getProductTourState(
  userId: string | null,
): Promise<ProductTourState> {
  if (!userId) return { pending: false, available: false };

  const { data, error } = await getSupabase()
    .from("users")
    .select("product_tour_completed_at, product_tour_skipped_at")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("[product-tour] state read failed", error);
    return { pending: false, available: false };
  }
  if (!data) return { pending: false, available: false };
  return {
    pending: !data.product_tour_completed_at && !data.product_tour_skipped_at,
    available: true,
  };
}

export async function recordProductTourOutcome(
  userId: string,
  outcome: ProductTourOutcome,
): Promise<void> {
  const now = new Date().toISOString();
  const values =
    outcome === "complete"
      ? { product_tour_completed_at: now }
      : { product_tour_skipped_at: now };
  const { error } = await getSupabase()
    .from("users")
    .update(values)
    .eq("id", userId);
  if (error) throw error;
}
