// The doorway between the owned catalog (our shipping data) and Eric's quote
// engine. Returns HIS exact types so his checkout never reads our tables.
import { getSupabase } from "../supabase.server";
import type { Parcel, Address } from "~/lib/ship-cost/adapters/rate-quote";

const G_TO_OZ = 0.0352739619;
const MM_TO_IN = 1 / 25.4;

/** metric variant_shipping row → imperial carrier Parcel (one conversion, shared). */
function toParcel(row: Record<string, unknown>): Parcel {
  return {
    lengthIn: Number(row.length_mm ?? 0) * MM_TO_IN,
    widthIn: Number(row.width_mm ?? 0) * MM_TO_IN,
    heightIn: Number(row.height_mm ?? 0) * MM_TO_IN,
    weightOz: Number(row.weight_grams ?? 0) * G_TO_OZ,
  };
}

export async function buildParcel(variantId: string): Promise<Parcel> {
  const { data, error } = await getSupabase()
    .from("variant_shipping")
    .select("weight_grams, length_mm, width_mm, height_mm")
    .eq("variant_id", variantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`no shipping data for variant ${variantId}`);
  return toParcel(data);
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

// Batched ship-data read for the quote path: ONE query answering everything the
// pipeline asks per cart — which variants CANNOT ship to the destination country
// (ISO-3166 alpha-2), the slowest per-variant handling window (the item that takes
// longest to prepare sets the shipment's handling days), and each variant's parcel
// dims/weight. `blocked` is order-preserving on the input. A variant with no
// variant_shipping row is treated as unrestricted with zero handling and NO parcel
// (absent from parcelByVariant → the engine's low-confidence fallback) — never block
// a sale on missing data (mirrors buildParcel's pre-migration tolerance).
export interface CartShipInfo {
  blocked: string[];
  maxHandlingDays: number;
  parcelByVariant: Map<string, Parcel>;
}

export async function cartShipInfo(
  variantIds: string[],
  destCountryIso2: string,
): Promise<CartShipInfo> {
  if (!variantIds.length) return { blocked: [], maxHandlingDays: 0, parcelByVariant: new Map() };
  const { data, error } = await getSupabase()
    .from("variant_shipping")
    .select("variant_id, restricted_countries, handling_days, weight_grams, length_mm, width_mm, height_mm")
    .in("variant_id", variantIds);
  if (error) throw error;

  const dest = destCountryIso2.toUpperCase();
  const restrictedByVariant = new Map<string, string[]>();
  const parcelByVariant = new Map<string, Parcel>();
  let maxHandlingDays = 0;
  for (const row of data ?? []) {
    const restricted = (Array.isArray(row.restricted_countries) ? (row.restricted_countries as string[]) : []).map((c) => c.toUpperCase());
    restrictedByVariant.set(String(row.variant_id), restricted);
    parcelByVariant.set(String(row.variant_id), toParcel(row));
    const handling = Number(row.handling_days ?? 0);
    if (Number.isFinite(handling) && handling > maxHandlingDays) maxHandlingDays = handling;
  }
  return {
    blocked: variantIds.filter((v) => (restrictedByVariant.get(v) ?? []).includes(dest)),
    maxHandlingDays,
    parcelByVariant,
  };
}
