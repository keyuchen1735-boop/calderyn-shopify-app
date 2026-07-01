// Import-from-Shopify (#13.promote): thin TS wrapper over the promote_shop_from_mirror
// SQL function, plus the honest merchant-facing report copy.
import { getSupabase } from "../supabase.server";

export interface PromoteCounts {
  products: number;
  variants: number;
  collections: number;
  balances: number;
}

/** Promote this shop's mirrored Shopify data into the owned tables. Idempotent (see the SQL fn). */
export async function promoteShopFromMirror(shopId: string): Promise<PromoteCounts> {
  const { data, error } = await getSupabase().rpc("promote_shop_from_mirror", { p_shop_id: shopId });
  if (error) throw new Error(`promote_shop_from_mirror failed: ${error.message}`);
  return data as PromoteCounts;
}

/**
 * Honest import summary. The exclusions are FIXED copy (not free-form): we always tell the
 * merchant that customers and store design are not part of this import, so the report can
 * never overstate what was brought over (rule 12).
 */
export function buildImportReport(
  counts: PromoteCounts,
  orderCount: number,
): { imported: string[]; notIncluded: string[] } {
  return {
    imported: [
      `${counts.products} products (${counts.variants} variants)`,
      `${counts.collections} collections`,
      // counts.balances is stock RECORDS (one per variant at each location), not locations.
      `${counts.balances} stock records`,
      `${orderCount} past orders (last 12 months)`,
    ],
    notIncluded: [
      "Your customer list, which is brought over separately, with consent (privacy rules).",
      "Your store design / theme, which is re-created in Calderyn's builder later.",
    ],
  };
}
