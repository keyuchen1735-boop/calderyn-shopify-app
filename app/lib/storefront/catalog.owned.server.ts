// app/lib/storefront/catalog.owned.server.ts
// The owned (DB-bound) StorefrontCatalog implementation over the Slice-1 tables
// (product_dim / variant_dim / product_media / collection_dim / product_collection).
// Behind getCatalog() this replaces the fixture so the storefront reads real
// products. The storefront is a PUBLIC, unauthenticated surface with no Postgres
// RLS, so EVERY query is scoped by shop_id (the contract-level tenancy defense),
// and only `active` products are exposed (draft/archived stay private).
import { getSupabase } from "../supabase.server";
import { signMediaPaths } from "../catalog/sign-media.server";
import type {
  StorefrontCatalog,
  StoreProduct,
  StoreVariant,
  StoreCollection,
} from "./catalog";

type Supa = ReturnType<typeof getSupabase>;
type Row = Record<string, unknown>;

const DEFAULT_CURRENCY = "USD";
// Hard cap so a large catalog can't assemble every product (+ sign every image) on
// one SSR render. The storefront has no pager yet; proper cursor pagination through
// the loaders is a follow-up. Until then this bounds the per-request cost.
const MAX_STOREFRONT_PRODUCTS = 250;

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function toVariant(v: Row, ledgerSellable?: number): StoreVariant {
  const tracked = (v.inventory_tracked as boolean | null) ?? false;
  // Stock truth is the Slice-2 inventory ledger — the same balances checkout
  // reserves and commits against. A variant the ledger has never seen (no balance
  // rows, e.g. editor-created before any stock was set) falls back to the editor's
  // static inventory_on_hand so it doesn't flip to sold-out spuriously.
  const stock = ledgerSellable ?? Number(v.inventory_on_hand ?? 0);
  // retail_price_cents is nullable and the write path doesn't require a price even
  // on an active product, so a variant can reach the storefront with no price. It
  // must NOT be sold as a free $0.00 line - treat a missing price as not-for-sale.
  const priced = v.retail_price_cents != null;
  return {
    id: String(v.id),
    sku: (v.sku as string | null) ?? null,
    title: String(v.title ?? "Default"),
    priceCents: priced ? Number(v.retail_price_cents) : 0,
    currency: (v.currency as string | null) ?? DEFAULT_CURRENCY,
    // A tracked variant is available iff it has sellable stock (on_hand minus
    // reserved, summed across locations); an untracked variant is always
    // available - but a price-less variant is never available.
    available: priced && (tracked ? stock > 0 : true),
  };
}

// Sellable stock per variant from the inventory ledger, summed across locations.
// Reads the generated `available` column (on_hand - reserved - unavailable), the
// SAME formula inventory_reserve() enforces at checkout, so the storefront can
// never show sellable what the reservation path would refuse. Chunks run in
// parallel and each chunk pages internally: its row count is variants x locations,
// which a single PostgREST page could silently truncate. Variants absent from the
// map have no ledger rows at all.
async function sellableByVariant(
  sb: Supa,
  shopId: string,
  variantIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!variantIds.length) return map;
  const CHUNK = 100;
  const PAGE = 1000;
  const chunks: string[][] = [];
  for (let i = 0; i < variantIds.length; i += CHUNK) chunks.push(variantIds.slice(i, i + CHUNK));
  await Promise.all(
    chunks.map(async (chunk) => {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb
          .from("inventory_balance")
          .select("variant_id, available")
          .eq("shop_id", shopId)
          .in("variant_id", chunk)
          .order("variant_id")
          .order("location_id")
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = (data ?? []) as Row[];
        for (const r of rows) {
          const id = String(r.variant_id);
          map.set(id, (map.get(id) ?? 0) + Number(r.available ?? 0));
        }
        if (rows.length < PAGE) return;
      }
    }),
  );
  return map;
}

// Assemble full StoreProducts for a set of ALREADY shop-scoped product rows:
// batch-load variants/media/collection links, sign image paths, and group by
// product. Child queries that carry shop_id are scoped by it too (defense in
// depth); product_media/product_collection key off product_id, and every id here
// came from a shop_id-filtered product query.
async function assemble(sb: Supa, shopId: string, products: Row[]): Promise<StoreProduct[]> {
  const ids = products.map((p) => String(p.id));
  if (!ids.length) return [];

  const [{ data: variants, error: vErr }, { data: media, error: mErr }, { data: pc, error: pcErr }] =
    await Promise.all([
      sb
        .from("variant_dim")
        .select("id, product_id, sku, title, retail_price_cents, currency, inventory_tracked, inventory_on_hand, position")
        .eq("shop_id", shopId)
        .in("product_id", ids)
        .order("position"),
      sb
        .from("product_media")
        .select("product_id, storage_path, external_url, alt, position, is_primary")
        .in("product_id", ids)
        .order("position"),
      sb.from("product_collection").select("product_id, collection_id").in("product_id", ids),
    ]);
  if (vErr) throw vErr;
  if (mErr) throw mErr;
  if (pcErr) throw pcErr;

  // Resolve collection ids -> handles, scoped to the shop so a foreign id can't
  // surface another tenant's collection handle.
  const collectionIds = [...new Set((pc ?? []).map((r: Row) => String(r.collection_id)))];
  const handleByCollectionId = new Map<string, string>();
  if (collectionIds.length) {
    const { data: colls, error: cErr } = await sb
      .from("collection_dim")
      .select("id, handle")
      .eq("shop_id", shopId)
      .in("id", collectionIds);
    if (cErr) throw cErr;
    for (const c of (colls ?? []) as Row[]) handleByCollectionId.set(String(c.id), String(c.handle));
  }

  // Ledger stock needs the variant ids, so it starts right after the variant fetch
  // and overlaps the image signing below (independent I/O).
  const sellablePromise = sellableByVariant(
    sb,
    shopId,
    ((variants ?? []) as Row[]).map((v) => String(v.id)),
  );

  const signed = await signMediaPaths(
    ((media ?? []) as Row[]).filter((m) => m.storage_path).map((m) => String(m.storage_path)),
  );
  const sellable = await sellablePromise;

  const variantsByProduct = new Map<string, StoreVariant[]>();
  for (const v of (variants ?? []) as Row[])
    pushInto(variantsByProduct, String(v.product_id), toVariant(v, sellable.get(String(v.id))));

  // Primary image leads, then by position. A promoted mirror image carries an
  // external_url (Shopify CDN, hotlinked) and is used directly; an owned/uploaded
  // image carries a private-bucket storage_path resolved through a signed url.
  // Rows that resolve to neither are dropped.
  const imagesByProduct = new Map<string, { url: string; alt: string | null }[]>();
  const orderedMedia = [...((media ?? []) as Row[])].sort(
    (a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)) || Number(a.position ?? 0) - Number(b.position ?? 0),
  );
  for (const m of orderedMedia) {
    const external = m.external_url ? String(m.external_url) : null;
    const url = external ?? signed.get(String(m.storage_path));
    if (!url) continue;
    pushInto(imagesByProduct, String(m.product_id), { url, alt: (m.alt as string | null) ?? null });
  }

  const handlesByProduct = new Map<string, string[]>();
  for (const r of (pc ?? []) as Row[]) {
    const handle = handleByCollectionId.get(String(r.collection_id));
    if (handle) pushInto(handlesByProduct, String(r.product_id), handle);
  }

  return products.map((p): StoreProduct => {
    const id = String(p.id);
    return {
      id,
      handle: String(p.handle),
      title: String(p.title),
      description: (p.description as string | null) ?? "",
      images: imagesByProduct.get(id) ?? [],
      variants: variantsByProduct.get(id) ?? [],
      collections: handlesByProduct.get(id) ?? [],
    };
  });
}

export const ownedCatalog: StorefrontCatalog = {
  async listProducts(shopId, opts) {
    const sb = getSupabase();

    // Collection filter: resolve the handle to a shop-scoped collection, then to
    // its product ids. An unknown handle or an empty collection yields no products.
    let restrictToIds: string[] | null = null;
    if (opts?.collection) {
      const { data: coll, error: cErr } = await sb
        .from("collection_dim")
        .select("id")
        .eq("shop_id", shopId)
        .eq("handle", opts.collection)
        .maybeSingle();
      if (cErr) throw cErr;
      if (!coll) return [];
      const { data: links, error: lErr } = await sb
        .from("product_collection")
        .select("product_id")
        .eq("collection_id", coll.id);
      if (lErr) throw lErr;
      restrictToIds = (links ?? []).map((r: Row) => String(r.product_id)).slice(0, MAX_STOREFRONT_PRODUCTS);
      if (!restrictToIds.length) return [];
    }

    let q = sb
      .from("product_dim")
      .select("id, handle, title, description")
      .eq("shop_id", shopId)
      .eq("status", "active");
    if (restrictToIds) q = q.in("id", restrictToIds);
    const { data: products, error } = await q.order("title").limit(MAX_STOREFRONT_PRODUCTS);
    if (error) throw error;
    return assemble(sb, shopId, (products ?? []) as Row[]);
  },

  async getProduct(shopId, handle) {
    const sb = getSupabase();
    const { data: p, error } = await sb
      .from("product_dim")
      .select("id, handle, title, description")
      .eq("shop_id", shopId)
      .eq("handle", handle)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    if (!p) return null;
    const [product] = await assemble(sb, shopId, [p as Row]);
    return product ?? null;
  },

  async listCollections(shopId) {
    const { data, error } = await getSupabase()
      .from("collection_dim")
      .select("handle, title")
      .eq("shop_id", shopId)
      .order("title");
    if (error) throw error;
    return (data ?? []).map((c: Row): StoreCollection => ({ handle: String(c.handle), title: String(c.title) }));
  },
};
