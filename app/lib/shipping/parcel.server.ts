// The doorway between the owned catalog (our shipping data) and Eric's quote
// engine. Returns HIS exact types so his checkout never reads our tables.
import { getSupabase } from "../supabase.server";
import type { Parcel, Address } from "~/lib/ship-cost/adapters/rate-quote";

const G_TO_OZ = 0.0352739619;
const MM_TO_IN = 1 / 25.4;

export async function buildParcel(variantId: string): Promise<Parcel> {
  const { data, error } = await getSupabase()
    .from("variant_shipping")
    .select("weight_grams, length_mm, width_mm, height_mm")
    .eq("variant_id", variantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`no shipping data for variant ${variantId}`);
  return {
    lengthIn: Number(data.length_mm ?? 0) * MM_TO_IN,
    widthIn: Number(data.width_mm ?? 0) * MM_TO_IN,
    heightIn: Number(data.height_mm ?? 0) * MM_TO_IN,
    weightOz: Number(data.weight_grams ?? 0) * G_TO_OZ,
  };
}

export async function originAddress(locationId: string): Promise<Address> {
  const { data, error } = await getSupabase()
    .from("location_dim")
    .select("name, street1, street2, city, region, postal_code, country")
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`location ${locationId} not found`);
  return {
    name: data.name ?? undefined,
    street1: String(data.street1 ?? ""),
    street2: data.street2 ?? undefined,
    city: String(data.city ?? ""),
    state: String(data.region ?? ""),
    zip: String(data.postal_code ?? ""),
    country: String(data.country ?? "US"),
  };
}

export async function canShipTo(variantId: string, destCountryIso2: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("variant_shipping")
    .select("restricted_countries")
    .eq("variant_id", variantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`no shipping data for variant ${variantId}`);
  const restricted = (Array.isArray(data.restricted_countries) ? (data.restricted_countries as string[]) : []).map((c) => c.toUpperCase());
  return !restricted.includes(destCountryIso2.toUpperCase());
}

// Batched restriction check for the quote path: given a set of variants and a destination
// country (ISO-3166 alpha-2), returns the subset that CANNOT ship there. Order-preserving
// on the input. A variant with no variant_shipping row is treated as unrestricted — never
// block a sale on missing data (mirrors buildParcel's pre-migration tolerance).
export async function restrictedVariants(variantIds: string[], destCountryIso2: string): Promise<string[]> {
  if (!variantIds.length) return [];
  const { data, error } = await getSupabase()
    .from("variant_shipping")
    .select("variant_id, restricted_countries")
    .in("variant_id", variantIds);
  if (error) throw error;

  const dest = destCountryIso2.toUpperCase();
  const restrictedByVariant = new Map<string, string[]>();
  for (const row of data ?? []) {
    const restricted = (Array.isArray(row.restricted_countries) ? (row.restricted_countries as string[]) : []).map((c) => c.toUpperCase());
    restrictedByVariant.set(String(row.variant_id), restricted);
  }
  return variantIds.filter((v) => (restrictedByVariant.get(v) ?? []).includes(dest));
}
