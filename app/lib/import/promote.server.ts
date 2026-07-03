// Import-from-Shopify (#13.promote): thin TS wrapper over the promote_shop_from_mirror
// SQL function, plus the honest merchant-facing report copy.
import { getSupabase } from "../supabase.server";

export interface PromoteCounts {
  products: number;
  variants: number;
  collections: number;
  balances: number;
  /** Historical orders promoted into imported_order (analytics continuity). */
  orders: number;
  /** Historical refunded lines promoted into imported_refund. */
  refunds: number;
}

/** Promote this shop's mirrored Shopify data into the owned tables. Idempotent (see the SQL fn). */
export async function promoteShopFromMirror(shopId: string): Promise<PromoteCounts> {
  const { data, error } = await getSupabase().rpc("promote_shop_from_mirror", { p_shop_id: shopId });
  if (error) throw new Error(`promote_shop_from_mirror failed: ${error.message}`);
  return data as PromoteCounts;
}

/**
 * Honest import summary. The exclusions are FIXED copy (not free-form) so the report can
 * never overstate what was brought over (rule 12). The order/refund counts are the rows
 * that actually landed in the owned imported_* tables (from the promote), not the raw pull
 * count — so the report reflects what was truly materialized. Customers appear in `imported`
 * only when the stage actually ran; while Shopify's protected-customer-data approval is
 * pending, they stay in notIncluded with the real reason.
 */
export function buildImportReport(
  counts: PromoteCounts,
  customers: { imported: number; skipped: number; blocked: boolean },
  relink: { linked: number; unmatched: number } = { linked: 0, unmatched: 0 },
): { imported: string[]; notIncluded: string[] } {
  const customersRan = !customers.blocked;
  return {
    imported: [
      `${counts.products} products (${counts.variants} variants)`,
      `${counts.collections} collections`,
      // counts.balances is stock RECORDS (one per variant at each location), not locations.
      `${counts.balances} stock records`,
      `${counts.orders} past orders (last 12 months)`,
      // Refund history rides along as read-only continuity; only surfaced when present so
      // a shop with no refunds doesn't get a "0 refunds" line.
      ...(counts.refunds > 0 ? [`${counts.refunds} past refunds`] : []),
      ...(customersRan
        ? [
            customers.skipped > 0
              ? `${customers.imported} customers (${customers.skipped} skipped — no email address)`
              : `${customers.imported} customers`,
          ]
        : []),
      // Order<->customer relink (#13.customers): only when orders were actually tied to a
      // re-pulled customer, so a run that linked nothing (guest-only history, or customer
      // access blocked) never claims a relink it didn't do.
      ...(relink.linked > 0 ? [`${relink.linked} past orders linked to customers`] : []),
    ],
    notIncluded: [
      ...(customersRan
        ? []
        : ["Your customer list — Shopify hasn't granted Calderyn customer-data access yet, so it couldn't come over this run."]),
      "Your store design / theme, which is re-created in Calderyn's builder later.",
    ],
  };
}
