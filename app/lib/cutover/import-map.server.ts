// import_map accessor (platform pivot Step 9, slice 2). The durable mirror<->owned bridge:
// (shop_id, entity_type, external_id [Shopify GID]) -> owned_id [uuid]. Server-only; reaches
// Postgres through the service-role client (getSupabase, BYPASSRLS), threading shop_id on every
// read/write. Populated by promote_shop_catalog + the one-time backfill; consumed by cutover
// webhook-dedup (lookupOwnedId) and the parity gate (getImportMapCounts).

import { getSupabase } from "~/lib/supabase.server";

export type ImportMapEntityType = "product" | "variant" | "location";
export const IMPORT_MAP_ENTITY_TYPES: readonly ImportMapEntityType[] = [
  "product",
  "variant",
  "location",
];

/** Resolve a Shopify entity's owned id, shop-scoped. Returns null on a miss (the caller treats
 *  that as "new entity" during importing/dual_run). */
export async function lookupOwnedId(
  shopId: string,
  entityType: ImportMapEntityType,
  externalId: string,
): Promise<string | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("import_map")
    .select("owned_id")
    .eq("shop_id", shopId)
    .eq("entity_type", entityType)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw error;
  const ownedId = (data as { owned_id?: unknown } | null)?.owned_id;
  return ownedId == null ? null : String(ownedId);
}

/** Record (or refresh) a bridge entry. Idempotent: upserts on the (shop, entity_type,
 *  external_id) unique key, so re-recording the same entity never duplicates. */
export async function recordImportMapEntry(
  shopId: string,
  entityType: ImportMapEntityType,
  externalId: string,
  ownedId: string,
  sourceVersion?: number,
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("import_map").upsert(
    {
      shop_id: shopId,
      entity_type: entityType,
      external_id: externalId,
      owned_id: ownedId,
      source_version: sourceVersion ?? null,
    },
    { onConflict: "shop_id,entity_type,external_id" },
  );
  if (error) throw error;
}

/** Per-entity mapped-row counts for a shop (0 for an entity with no rows) — the parity gate's
 *  owned-side input. */
export async function getImportMapCounts(
  shopId: string,
): Promise<Record<ImportMapEntityType, number>> {
  const sb = getSupabase();
  const { data, error } = await sb.from("import_map").select("entity_type").eq("shop_id", shopId);
  if (error) throw error;
  const counts: Record<ImportMapEntityType, number> = { product: 0, variant: 0, location: 0 };
  for (const row of (data ?? []) as Array<{ entity_type?: unknown }>) {
    const t = String(row.entity_type);
    if (t === "product" || t === "variant" || t === "location") counts[t] += 1;
  }
  return counts;
}
