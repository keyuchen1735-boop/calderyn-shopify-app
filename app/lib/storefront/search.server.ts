import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getCatalog } from "~/lib/storefront/catalog.server";
import type { StoreProduct, StoreVariant } from "~/lib/storefront/catalog";

const MAX_SCAN = 250;
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

interface CursorPayload { v: 1; offset: number; fingerprint: string }

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
    if (row.v !== 1 || !Number.isInteger(row.offset) || Number(row.offset) < 0
      || typeof row.fingerprint !== "string" || row.fingerprint.length !== 64) throw new Error();
    return { v: 1, offset: Number(row.offset), fingerprint: row.fingerprint };
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

function lower(value: string): string { return value.toLocaleLowerCase("en-US"); }
function variantFor(product: StoreProduct): StoreVariant | null {
  return product.variants.slice().sort((a, b) => a.priceCents - b.priceCents || a.id.localeCompare(b.id))[0] ?? null;
}
function available(product: StoreProduct): boolean { return product.variants.some((variant) => variant.available); }
function price(product: StoreProduct): number { return variantFor(product)?.priceCents ?? Number.MAX_SAFE_INTEGER; }

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

export async function searchStorefront(shopId: string, input: StorefrontSearchInput) {
  const products = await getCatalog().listProducts(shopId, {
    limit: MAX_SCAN,
    ...(input.query ? { query: input.query } : {}),
  });
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
  filtered = filtered.slice().sort((a, b) => {
    if (input.sort === "title_asc") return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    if (input.sort === "title_desc") return b.title.localeCompare(a.title) || a.id.localeCompare(b.id);
    if (input.sort === "price_asc") return price(a) - price(b) || a.id.localeCompare(b.id);
    if (input.sort === "price_desc") return price(b) - price(a) || a.id.localeCompare(b.id);
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
  const expectedFingerprint = fingerprint(shopId, input);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor && cursor.fingerprint !== expectedFingerprint) throw new InvalidSearchRequestError();
  const offset = cursor?.offset ?? 0;
  if (offset > filtered.length) throw new InvalidSearchRequestError();
  const page = filtered.slice(offset, offset + input.limit);
  const nextOffset = offset + page.length;
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
    nextCursor: nextOffset < filtered.length
      ? encodeCursor({ v: 1, offset: nextOffset, fingerprint: expectedFingerprint })
      : null,
  };
}
