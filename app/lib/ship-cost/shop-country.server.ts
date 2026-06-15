import type { SupabaseClient } from "@supabase/supabase-js";

// No shop origin country is stored yet (shops has no country column). Returns
// null → zone classifier treats every order as domestic. TODO: source shop
// origin country (Shopify shop.countryCode) in a later pass.
export async function getShopCountry(
  _sb: SupabaseClient,
  _shopId: string,
): Promise<string | null> {
  return null;
}
