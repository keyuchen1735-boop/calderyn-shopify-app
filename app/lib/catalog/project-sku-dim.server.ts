// app/lib/catalog/project-sku-dim.server.ts
//
// sku_dim stays the engine's read model (a real table — it is a FK target and 7
// views depend on it). The owned product/variant tables are the write authority;
// after any catalog write the editor calls this to rebuild that product's sku_dim
// rows. The variant id is carried verbatim into sku_dim.id so order/refund/
// inventory references never break.
import { getSupabase } from "../supabase.server";

export async function projectProductToSkuDim(productId: string): Promise<void> {
  const sb = getSupabase();

  const { data: product, error: pErr } = await sb
    .from("product_dim")
    .select("id, shop_id, external_id, status, vendor, category, tags")
    .eq("id", productId)
    .single();
  if (pErr) throw pErr;

  const { data: variants, error: vErr } = await sb
    .from("variant_dim")
    .select("id, external_id, inventory_item_id, sku, title, price_tier, retail_price_cents, unit_cost_cents, currency, grams, inventory_policy, inventory_tracked")
    .eq("product_id", productId);
  if (vErr) throw vErr;

  const { data: cols, error: cErr } = await sb
    .from("product_collection")
    .select("collection:collection_dim(title)")
    .eq("product_id", productId);
  if (cErr) throw cErr;
  // supabase-js infers a to-one embed as an array; PostgREST actually returns the
  // to-one relation as a single object. Cast to that shape (repo convention:
  // `(data ?? []) as unknown as Row[]`) so the title read is correctly typed.
  const collections = ((cols ?? []) as unknown as Array<{ collection: { title: string } | null }>)
    .map((r) => r.collection?.title)
    .filter((t): t is string => Boolean(t));

  const productExternal = product.external_id ?? String(product.id);
  const rows = (variants ?? []).map((v: Record<string, unknown>) => ({
    id: String(v.id),                                   // INVARIANT: sku_dim.id == variant_dim.id
    shop_id: String(product.shop_id),
    external_id: (v.external_id as string | null) ?? String(v.id),
    product_id: productExternal,
    inventory_item_id: v.inventory_item_id ?? null,
    sku: v.sku ?? null,
    title: v.title ?? "Default",
    category: product.category ?? null,
    price_tier: v.price_tier ?? null,
    unit_cost_cents: v.unit_cost_cents ?? null,
    currency: v.currency ?? "USD",
    tags: product.tags ?? [],
    grams: v.grams ?? null,
    vendor: product.vendor ?? null,
    collections,
    inventory_policy: v.inventory_policy ?? null,
    inventory_tracked: v.inventory_tracked ?? null,
    retail_price_cents: v.retail_price_cents ?? null,
    product_status: product.status ?? null,
  }));

  if (rows.length) {
    const { error: upErr } = await sb.from("sku_dim").upsert(rows, { onConflict: "id" });
    if (upErr) throw upErr;
  }

  // Remove sku_dim rows for variants that no longer exist on this product.
  const keepIds = rows.map((r) => r.id);
  const del = sb.from("sku_dim").delete().eq("product_id", productExternal);
  const { error: delErr } = keepIds.length
    ? await del.notIn("id", keepIds)
    : await del;
  if (delErr) throw delErr;
}
