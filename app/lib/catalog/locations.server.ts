import type { SupabaseClient } from "@supabase/supabase-js";

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
