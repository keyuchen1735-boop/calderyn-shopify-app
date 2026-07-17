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
  StorefrontCatalogSearchPage,
  StoreProduct,
  StoreVariant,
  StoreCollection,
} from "./catalog";
import {
  decodeProductPageCursor,
  encodeProductPageCursor,
  MAX_STOREFRONT_CARD_DESCRIPTION_CODE_POINTS,
  MAX_PUBLIC_PRODUCT_PAGE_SIZE,
  MISSING_PRICE_ASC_SORT_VALUE,
  MISSING_PRICE_DESC_SORT_VALUE,
} from "./catalog";

type Supa = ReturnType<typeof getSupabase>;
type Row = Record<string, unknown>;

const DEFAULT_CURRENCY = "USD";
// Hard cap for bounded/curated reads. Public catalog traversal uses listProductPage.
const MAX_STOREFRONT_PRODUCTS = 250;
const POSTGREST_PAGE_SIZE = 1000;
const POSTGREST_IN_CHUNK_SIZE = 200;

function postgrestLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

async function pagedRows(
  query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
    const result = await query(from, from + POSTGREST_PAGE_SIZE - 1);
    if (result.error) throw result.error;
    const page = (result.data ?? []) as Row[];
    rows.push(...page);
    if (page.length < POSTGREST_PAGE_SIZE) return rows;
  }
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
    compareAtPriceCents: v.compare_at_price_cents == null ? null : Number(v.compare_at_price_cents),
    currency: (v.currency as string | null) ?? DEFAULT_CURRENCY,
    // A tracked variant is available iff it has sellable stock (on_hand minus
    // reserved, summed across locations); an untracked variant is always
    // available - but a price-less variant is never available.
    available: priced && (tracked ? stock > 0 : true),
    hasPrice: priced,
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

  const [variants, media, pc, options] = await Promise.all([
    pagedRows((from, to) => sb
        .from("variant_dim")
        .select("id, product_id, sku, title, retail_price_cents, compare_at_price_cents, currency, inventory_tracked, inventory_on_hand, position")
        .eq("shop_id", shopId)
        .in("product_id", ids)
        .order("position").order("product_id").order("id").range(from, to)),
    pagedRows((from, to) => sb
        .from("product_media")
        .select("id, product_id, storage_path, external_url, alt, position, is_primary")
        .in("product_id", ids)
        .order("position").order("product_id").order("id").range(from, to)),
    pagedRows((from, to) => sb.from("product_collection").select("product_id, collection_id")
      .in("product_id", ids).order("product_id").order("collection_id").range(from, to)),
    pagedRows((from, to) => sb
        .from("product_option")
        .select("id, product_id, name, position, product_option_value(value, position)")
        .in("product_id", ids)
        .order("position").order("product_id").order("id").range(from, to)),
  ]);

  // Resolve collection ids -> handles, scoped to the shop so a foreign id can't
  // surface another tenant's collection handle.
  const collectionIds = [...new Set(pc.map((r) => String(r.collection_id)))];
  const handleByCollectionId = new Map<string, string>();
  if (collectionIds.length) {
    const chunks: string[][] = [];
    for (let i = 0; i < collectionIds.length; i += POSTGREST_IN_CHUNK_SIZE)
      chunks.push(collectionIds.slice(i, i + POSTGREST_IN_CHUNK_SIZE));
    const pages = await Promise.all(chunks.map((chunk) => pagedRows((from, to) => sb
        .from("collection_dim")
        .select("id, handle")
        .eq("shop_id", shopId)
        .in("id", chunk)
        .order("id")
        .range(from, to))));
    for (const page of pages)
      for (const c of page) handleByCollectionId.set(String(c.id), String(c.handle));
  }

  // Ledger stock needs the variant ids, so it starts right after the variant fetch
  // and overlaps the image signing below (independent I/O).
  const sellablePromise = sellableByVariant(
    sb,
    shopId,
    variants.map((v) => String(v.id)),
  );

  const signed = await signMediaPaths(
    media.filter((m) => m.storage_path).map((m) => String(m.storage_path)),
  );
  const sellable = await sellablePromise;

  const variantsByProduct = new Map<string, StoreVariant[]>();
  for (const v of variants)
    pushInto(variantsByProduct, String(v.product_id), toVariant(v, sellable.get(String(v.id))));

  // Primary image leads, then by position. A promoted mirror image carries an
  // external_url (Shopify CDN, hotlinked) and is used directly; an owned/uploaded
  // image carries a private-bucket storage_path resolved through a signed url.
  // Rows that resolve to neither are dropped.
  const imagesByProduct = new Map<string, { url: string; alt: string | null }[]>();
  const orderedMedia = media.slice().sort(
    (a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)) || Number(a.position ?? 0) - Number(b.position ?? 0),
  );
  for (const m of orderedMedia) {
    const external = m.external_url ? String(m.external_url) : null;
    const url = external ?? signed.get(String(m.storage_path));
    if (!url) continue;
    pushInto(imagesByProduct, String(m.product_id), { url, alt: (m.alt as string | null) ?? null });
  }

  const handlesByProduct = new Map<string, string[]>();
  for (const r of pc) {
    const handle = handleByCollectionId.get(String(r.collection_id));
    if (handle) pushInto(handlesByProduct, String(r.product_id), handle);
  }

  const optionsByProduct = new Map<string, Array<{ name: string; values: string[] }>>();
  for (const option of options) {
    const values = ((option.product_option_value as Row[] | null) ?? [])
      .slice()
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
      .map((value) => String(value.value));
    pushInto(optionsByProduct, String(option.product_id), { name: String(option.name), values });
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
      options: optionsByProduct.get(id) ?? [],
      collections: handlesByProduct.get(id) ?? [],
      category: (p.category as string | null) ?? null,
      tags: (p.tags as string[] | null) ?? [],
    };
  });
}

function parseFacets(value: unknown): Array<{ value: string; count: number }> {
  if (!Array.isArray(value) || value.length > 20) throw new Error("invalid storefront catalog search response");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("invalid storefront catalog search response");
    }
    const row = entry as Row;
    if (typeof row.value !== "string" || !Number.isSafeInteger(row.count) || Number(row.count) < 1) {
      throw new Error("invalid storefront catalog search response");
    }
    return { value: row.value, count: Number(row.count) };
  });
}

interface ParsedSearchImage {
  storagePath: string | null;
  externalUrl: string | null;
  alt: string | null;
}

interface ParsedSearchCard {
  product: StoreProduct;
  image: ParsedSearchImage | null;
}

function invalidSearchResponse(): never {
  throw new Error("invalid storefront catalog search response");
}

function parseSearchVariant(value: unknown): StoreVariant | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidSearchResponse();
  const row = value as Row;
  const price = row.price_cents;
  const compareAt = row.compare_at_price_cents;
  if (typeof row.id !== "string" || !row.id
    || (row.sku !== null && typeof row.sku !== "string")
    || typeof row.title !== "string"
    || (price !== null && (!Number.isSafeInteger(price) || Number(price) < 0))
    || (compareAt !== null && (!Number.isSafeInteger(compareAt) || Number(compareAt) < 0))
    || typeof row.currency !== "string" || !row.currency
    || typeof row.available !== "boolean"
    || (price === null && row.available)) return invalidSearchResponse();
  return {
    id: row.id,
    sku: row.sku as string | null,
    title: row.title,
    priceCents: price === null ? 0 : Number(price),
    compareAtPriceCents: compareAt === null ? null : Number(compareAt),
    currency: row.currency,
    available: row.available,
    hasPrice: price !== null,
  };
}

function parseSearchImage(value: unknown): ParsedSearchImage | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidSearchResponse();
  const row = value as Row;
  const storagePath = row.storage_path;
  const externalUrl = row.external_url;
  if ((storagePath !== null && (typeof storagePath !== "string" || !storagePath))
    || (externalUrl !== null && (typeof externalUrl !== "string" || !externalUrl))
    || (row.alt !== null && typeof row.alt !== "string")
    || (storagePath === null && externalUrl === null)) return invalidSearchResponse();
  return {
    storagePath: storagePath as string | null,
    externalUrl: externalUrl as string | null,
    alt: row.alt as string | null,
  };
}

function parseSearchCard(value: unknown): ParsedSearchCard {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidSearchResponse();
  const row = value as Row;
  if (typeof row.id !== "string" || !row.id
    || typeof row.handle !== "string" || !row.handle
    || typeof row.title !== "string"
    || typeof row.description !== "string"
    || [...row.description].length > MAX_STOREFRONT_CARD_DESCRIPTION_CODE_POINTS) return invalidSearchResponse();
  const variant = parseSearchVariant(row.variant);
  return {
    product: {
      id: row.id,
      handle: row.handle,
      title: row.title,
      description: row.description,
      images: [],
      variants: variant ? [variant] : [],
      collections: [],
      category: null,
      tags: [],
    },
    image: parseSearchImage(row.image),
  };
}

function parseSearchResponse(
  value: unknown,
  opts: { sort: string; limit: number },
): Omit<StorefrontCatalogSearchPage, "items"> & { cards: ParsedSearchCard[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidSearchResponse();
  }
  const row = value as Row;
  const cards = Array.isArray(row.cards) ? row.cards.map(parseSearchCard) : null;
  const facets = row.facets;
  if (!cards || cards.length > Math.min(opts.limit, MAX_PUBLIC_PRODUCT_PAGE_SIZE)
    || new Set(cards.map(({ product }) => product.id)).size !== cards.length
    || !Number.isSafeInteger(row.total) || Number(row.total) < 0
    || Number(row.total) < cards.length
    || typeof row.has_next_page !== "boolean"
    || !facets || typeof facets !== "object" || Array.isArray(facets)) {
    return invalidSearchResponse();
  }
  const boundaryRow = row.boundary;
  const priceSort = opts.sort === "price_asc" || opts.sort === "price_desc";
  let boundary: { sortValue: string | number; productId: string } | null = null;
  if (boundaryRow !== null) {
    if (!boundaryRow || typeof boundaryRow !== "object" || Array.isArray(boundaryRow)) return invalidSearchResponse();
    const candidate = boundaryRow as Row;
    if (typeof candidate.product_id !== "string" || !candidate.product_id
      || (priceSort
        ? !Number.isSafeInteger(candidate.sort_value)
          || (Number(candidate.sort_value) < 0
            && !(opts.sort === "price_desc" && candidate.sort_value === MISSING_PRICE_DESC_SORT_VALUE))
        : typeof candidate.sort_value !== "string")) return invalidSearchResponse();
    boundary = { sortValue: candidate.sort_value as string | number, productId: candidate.product_id };
  }
  const last = cards.at(-1)?.product;
  const lastVariant = last?.variants[0];
  const expectedSortValue = priceSort
    ? lastVariant && lastVariant.hasPrice !== false
      ? lastVariant.priceCents
      : opts.sort === "price_desc" ? MISSING_PRICE_DESC_SORT_VALUE : MISSING_PRICE_ASC_SORT_VALUE
    : last?.title;
  if (row.has_next_page
    ? !last || !boundary || boundary.productId !== last.id || boundary.sortValue !== expectedSortValue
    : boundary !== null) return invalidSearchResponse();
  const facetRows = facets as Row;
  return {
    cards,
    boundary,
    total: Number(row.total),
    hasNextPage: row.has_next_page,
    facets: {
      categories: parseFacets(facetRows.categories),
      tags: parseFacets(facetRows.tags),
      collections: parseFacets(facetRows.collections),
    },
  };
}

export const ownedCatalog: StorefrontCatalog = {
  async searchProductPage(shopId, opts) {
    const sb = getSupabase();
    const { data, error } = await sb.rpc("storefront_catalog_search_page", {
      p_shop_id: shopId,
      p_query: opts.query,
      p_collection: opts.collection,
      p_category: opts.category,
      p_tag: opts.tag,
      p_available: opts.available,
      p_sort: opts.sort,
      p_after_value: opts.after ? String(opts.after.sortValue) : null,
      p_after_product_id: opts.after?.productId ?? null,
      p_limit: opts.limit,
    });
    if (error) throw error;
    const { cards, ...metadata } = parseSearchResponse(data, opts);
    const paths = [...new Set(cards.flatMap(({ image }) =>
      image?.storagePath && !image.externalUrl ? [image.storagePath] : []))];
    const signed = await signMediaPaths(paths);
    return {
      ...metadata,
      items: cards.map(({ product, image }) => {
        if (!image) return product;
        const url = image.externalUrl ?? (image.storagePath ? signed.get(image.storagePath) : null);
        return url ? { ...product, images: [{ url, alt: image.alt }] } : product;
      }),
    };
  },

  async listProductPage(shopId, opts) {
    const sb = getSupabase();
    let collectionId: string | null = null;
    if (opts.collection) {
      const { data, error } = await sb
        .from("collection_dim")
        .select("id")
        .eq("shop_id", shopId)
        .eq("handle", opts.collection)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { items: [], nextCursor: null };
      collectionId = String(data.id);
    }

    const products = sb.from("product_dim");
    let q = (collectionId
      ? products.select("id, handle, title, description, category, tags, product_collection!inner(collection_id)")
      : products.select("id, handle, title, description, category, tags"))
      .eq("shop_id", shopId)
      .eq("status", "active");
    if (collectionId) q = q.eq("product_collection.collection_id", collectionId);
    if (opts.query) {
      const literal = opts.query
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
      q = q.ilike("title", `%${literal}%`);
    }
    if (opts.cursor) {
      const cursor = decodeProductPageCursor(opts.cursor);
      const title = postgrestLiteral(cursor.title);
      q = q.or(`title.gt.${title},and(title.eq.${title},id.gt.${postgrestLiteral(cursor.id)})`);
    }
    const requested = Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 1;
    const limit = Math.min(Math.max(requested, 1), MAX_PUBLIC_PRODUCT_PAGE_SIZE);
    const { data, error } = await q.order("title").order("id").limit(limit + 1);
    if (error) throw error;
    const rows = ((data ?? []) as unknown as Row[]).slice(0, limit);
    const last = rows.at(-1);
    return {
      items: await assemble(sb, shopId, rows),
      nextCursor: last && (data ?? []).length > limit
        ? encodeProductPageCursor(String(last.title), String(last.id))
        : null,
    };
  },

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
    } else if (opts?.ids) {
      // Explicit-id grids: fetch and assemble ONLY the referenced products — never the
      // whole catalog (assemble signs every image URL, so a full fetch is hot-path poison).
      restrictToIds = opts.ids.slice(0, MAX_STOREFRONT_PRODUCTS);
      if (!restrictToIds.length) return [];
    }

    let q = sb
      .from("product_dim")
      .select("id, handle, title, description, category, tags")
      .eq("shop_id", shopId)
      .eq("status", "active");
    if (restrictToIds) q = q.in("id", restrictToIds);
    if (opts?.query) {
      const literal = opts.query
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
      q = q.ilike("title", `%${literal}%`);
    }
    const limit = Math.min(Math.max(opts?.limit ?? MAX_STOREFRONT_PRODUCTS, 0), MAX_STOREFRONT_PRODUCTS);
    const { data: products, error } = await q.order("title").limit(limit);
    if (error) throw error;
    // Ordering is stable/alphabetical here; visitor-specific weather boosting is
    // applied at the render layer (resolveRenderData) where the shopper's request
    // (and thus their local weather) is available.
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

  async getVariantById(shopId, variantId) {
    const sb = getSupabase();
    const variantResult = await sb
      .from("variant_dim")
      .select("id, product_id, sku, title, retail_price_cents, compare_at_price_cents, currency, inventory_tracked, inventory_on_hand")
      .eq("shop_id", shopId)
      .eq("id", variantId)
      .maybeSingle();
    if (variantResult.error) throw variantResult.error;
    if (!variantResult.data) return null;

    const variantRow = variantResult.data as Row;
    const productResult = await sb
      .from("product_dim")
      .select("id, handle, title, description, category, tags")
      .eq("shop_id", shopId)
      .eq("id", String(variantRow.product_id))
      .eq("status", "active")
      .maybeSingle();
    if (productResult.error) throw productResult.error;
    if (!productResult.data) return null;

    const sellable = await sellableByVariant(sb, shopId, [variantId]);
    const productRow = productResult.data as Row;
    const variant = toVariant(variantRow, sellable.get(variantId));
    const product: StoreProduct = {
      id: String(productRow.id),
      handle: String(productRow.handle),
      title: String(productRow.title),
      description: (productRow.description as string | null) ?? "",
      images: [],
      variants: [variant],
      collections: [],
      category: (productRow.category as string | null) ?? null,
      tags: (productRow.tags as string[] | null) ?? [],
    };
    return { product, variant };
  },

  async getCollection(shopId, handle) {
    const client = getSupabase();
    const collectionResult = await client
      .from("collection_dim")
      .select("id, handle, title, description")
      .eq("shop_id", shopId)
      .eq("handle", handle)
      .maybeSingle();
    if (collectionResult.error) throw collectionResult.error;
    if (!collectionResult.data) return null;
    const collection = collectionResult.data as Row;
    const countResult = await client
      .from("product_collection")
      .select("product_dim!inner(id)", { count: "exact", head: true })
      .eq("collection_id", String(collection.id))
      .eq("product_dim.shop_id", shopId)
      .eq("product_dim.status", "active");
    if (countResult.error) throw countResult.error;
    return {
      id: String(collection.id),
      handle: String(collection.handle),
      title: String(collection.title),
      description: (collection.description as string | null) ?? "",
      productCount: countResult.count ?? 0,
    };
  },

  async listCollections(shopId) {
    const { data, error } = await getSupabase()
      .from("collection_dim")
      .select("id, handle, title, description")
      .eq("shop_id", shopId)
      .order("title");
    if (error) throw error;
    return (data ?? []).map((c: Row): StoreCollection => ({
      handle: String(c.handle),
      title: String(c.title),
      ...(c.id == null ? {} : { id: String(c.id) }),
      ...(c.description == null ? {} : { description: String(c.description) }),
    }));
  },
};
