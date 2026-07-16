import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getCatalog } from "~/lib/storefront/catalog.server";
import type { StorefrontCatalog, StoreProduct, StoreVariant } from "~/lib/storefront/catalog";

const MAX_RESULTS = 24;
const MAX_FACETS = 20;
const SORTS = ["relevance", "title_asc", "title_desc", "price_asc", "price_desc"] as const;

export type StorefrontSearchSort = typeof SORTS[number];

export interface StorefrontSearchInput {
  query: string;
  collection: string | null;
  category: string | null;
  tag: string | null;
  available: boolean | null;
  sort: StorefrontSearchSort;
  limit: number;
  cursor: string | null;
}

interface CursorPayload { v: 2; sortValue: string | number; productId: string; fingerprint: string }

export class InvalidSearchRequestError extends Error {
  constructor() {
    super("invalid storefront search request");
    this.name = "InvalidSearchRequestError";
  }
}

function secret(): string {
  const value = process.env.SHOPIFY_API_SECRET;
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("SHOPIFY_API_SECRET must be set to sign storefront search cursors");
  }
  return value || "development-storefront-search-cursor";
}

function decodeCursor(token: string): CursorPayload {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw new InvalidSearchRequestError();
  const expected = createHmac("sha256", secret()).update(encoded).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    throw new InvalidSearchRequestError();
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new InvalidSearchRequestError();
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const row = value as Record<string, unknown>;
    if (row.v !== 2 || (typeof row.sortValue !== "string" && typeof row.sortValue !== "number")
      || (typeof row.sortValue === "number" && !Number.isFinite(row.sortValue))
      || typeof row.productId !== "string" || row.productId.length === 0
      || typeof row.fingerprint !== "string" || row.fingerprint.length !== 64) throw new Error();
    return { v: 2, sortValue: row.sortValue, productId: row.productId, fingerprint: row.fingerprint };
  } catch {
    throw new InvalidSearchRequestError();
  }
}

function encodeCursor(payload: CursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function boundedText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
  if (!normalized || normalized.length > max || hasControlCharacter) {
    throw new InvalidSearchRequestError();
  }
  return normalized;
}

export function parseStorefrontSearchParams(params: URLSearchParams): StorefrontSearchInput {
  const allowed = new Set(["q", "collection", "category", "tag", "available", "sort", "limit", "cursor"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new InvalidSearchRequestError();
  }
  const query = params.has("q") ? boundedText(params.get("q"), 120) ?? "" : "";
  const collection = boundedText(params.get("collection"), 80);
  const category = boundedText(params.get("category"), 80);
  const tag = boundedText(params.get("tag"), 80);
  const availableRaw = params.get("available");
  const available = availableRaw === null ? null
    : availableRaw === "true" ? true
      : availableRaw === "false" ? false
        : (() => { throw new InvalidSearchRequestError(); })();
  const sortRaw = params.get("sort") ?? "relevance";
  if (!SORTS.includes(sortRaw as StorefrontSearchSort)) throw new InvalidSearchRequestError();
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? 12 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new InvalidSearchRequestError();
  const cursor = params.get("cursor");
  if (cursor) decodeCursor(cursor);
  return { query, collection, category, tag, available, sort: sortRaw as StorefrontSearchSort, limit, cursor };
}

const COLLECTION_FACETS = new Set(["category", "tag", "available"]);

/** Translate runtime collection controls into the closed Task 6 search grammar. */
export function parseStorefrontCollectionParams(
  params: URLSearchParams,
  collectionHandle: string,
): StorefrontSearchInput {
  const translated = new URLSearchParams({ collection: collectionHandle });
  for (const [key, value] of params) {
    if (params.getAll(key).length !== 1) throw new InvalidSearchRequestError();
    if (key === "sort" || key === "limit" || key === "cursor") {
      translated.set(key, value);
      continue;
    }
    if (!key.startsWith("filter.")) throw new InvalidSearchRequestError();
    const facet = key.slice("filter.".length);
    if (!COLLECTION_FACETS.has(facet)) throw new InvalidSearchRequestError();
    if (value) translated.set(facet, value);
  }
  if (!translated.has("limit")) translated.set("limit", String(MAX_RESULTS));
  return parseStorefrontSearchParams(translated);
}

function lower(value: string): string { return value.toLocaleLowerCase("en-US"); }
function variantFor(product: StoreProduct): StoreVariant | null {
  return product.variants.slice().sort((a, b) => a.priceCents - b.priceCents || a.id.localeCompare(b.id))[0] ?? null;
}
function available(product: StoreProduct): boolean { return product.variants.some((variant) => variant.available); }
function price(product: StoreProduct): number { return variantFor(product)?.priceCents ?? Number.MAX_SAFE_INTEGER; }
function sortValue(product: StoreProduct, sort: StorefrontSearchSort): string | number {
  return sort === "price_asc" || sort === "price_desc" ? price(product) : product.title;
}

function compareProducts(a: StoreProduct, b: StoreProduct, sort: StorefrontSearchSort): number {
  if (sort === "title_desc") return b.title.localeCompare(a.title) || a.id.localeCompare(b.id);
  if (sort === "price_asc") return price(a) - price(b) || a.id.localeCompare(b.id);
  if (sort === "price_desc") return price(b) - price(a) || a.id.localeCompare(b.id);
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

function compareProductToCursor(product: StoreProduct, cursor: CursorPayload, sort: StorefrontSearchSort): number {
  const value = sortValue(product, sort);
  if (typeof value !== typeof cursor.sortValue) throw new InvalidSearchRequestError();
  if (typeof value === "number" && typeof cursor.sortValue === "number") {
    const order = sort === "price_desc" ? cursor.sortValue - value : value - cursor.sortValue;
    return order || product.id.localeCompare(cursor.productId);
  }
  const title = String(value);
  const cursorTitle = String(cursor.sortValue);
  const order = sort === "title_desc" ? cursorTitle.localeCompare(title) : title.localeCompare(cursorTitle);
  return order || product.id.localeCompare(cursor.productId);
}

function fingerprint(shopId: string, input: StorefrontSearchInput): string {
  return createHash("sha256").update(JSON.stringify({
    shopId,
    query: input.query,
    collection: input.collection,
    category: input.category,
    tag: input.tag,
    available: input.available,
    sort: input.sort,
    limit: input.limit,
  })).digest("hex");
}

function facet(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, MAX_FACETS);
}

export async function searchStorefront(
  shopId: string,
  input: StorefrontSearchInput,
  catalog: StorefrontCatalog = getCatalog(),
) {
  // ponytail: full traversal preserves full-field facets and sorting; move those
  // operations into the catalog query only when catalog-scale latency warrants it.
  const products: StoreProduct[] = [];
  let catalogCursor: string | null = null;
  do {
    const page = await catalog.listProductPage(shopId, {
      ...(input.collection ? { collection: input.collection } : {}),
      cursor: catalogCursor,
      limit: MAX_RESULTS,
    });
    products.push(...page.items);
    catalogCursor = page.nextCursor;
  } while (catalogCursor);
  const query = lower(input.query);
  let filtered = products.filter((product) => {
    if (query && !lower(`${product.title} ${product.description} ${product.category ?? ""} ${(product.tags ?? []).join(" ")}`).includes(query)) return false;
    if (input.collection && !product.collections.some((value) => lower(value) === lower(input.collection!))) return false;
    if (input.category && lower(product.category ?? "") !== lower(input.category)) return false;
    if (input.tag && !(product.tags ?? []).some((value) => lower(value) === lower(input.tag!))) return false;
    if (input.available !== null && available(product) !== input.available) return false;
    return true;
  });
  const facets = {
    categories: facet(filtered.map((product) => product.category ?? "")),
    tags: facet(filtered.flatMap((product) => product.tags ?? [])),
    collections: facet(filtered.flatMap((product) => product.collections)),
  };
  filtered = filtered.slice().sort((a, b) => compareProducts(a, b, input.sort));
  const expectedFingerprint = fingerprint(shopId, input);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor && cursor.fingerprint !== expectedFingerprint) throw new InvalidSearchRequestError();
  const remaining = cursor
    ? filtered.filter((product) => compareProductToCursor(product, cursor, input.sort) > 0)
    : filtered;
  const page = remaining.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map((product) => {
      const variant = variantFor(product);
      return {
        id: product.id,
        handle: product.handle,
        title: product.title,
        image: product.images[0] ?? null,
        variantId: variant?.id ?? null,
        priceCents: variant?.priceCents ?? null,
        compareAtPriceCents: variant?.compareAtPriceCents ?? null,
        currency: variant?.currency.toLowerCase() ?? "usd",
        available: available(product),
      };
    }),
    facets,
    total: filtered.length,
    nextCursor: last && page.length < remaining.length
      ? encodeCursor({
          v: 2,
          sortValue: sortValue(last, input.sort),
          productId: last.id,
          fingerprint: expectedFingerprint,
        })
      : null,
  };
}
