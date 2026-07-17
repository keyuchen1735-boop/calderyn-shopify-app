import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getCatalog } from "~/lib/storefront/catalog.server";
import type {
  StorefrontCatalog,
  StorefrontCatalogSearchSort,
  StoreProduct,
  StoreVariant,
} from "~/lib/storefront/catalog";
import {
  capStorefrontCardDescription,
  selectStorefrontPriceVariant,
} from "~/lib/storefront/catalog";

const MAX_RESULTS = 24;
const SORTS = ["relevance", "title_asc", "title_desc", "price_asc", "price_desc"] as const;

export type StorefrontSearchSort = StorefrontCatalogSearchSort;

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

function variantFor(product: StoreProduct): StoreVariant | null {
  return selectStorefrontPriceVariant(product);
}
function available(product: StoreProduct): boolean { return product.variants.some((variant) => variant.available); }

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

export async function searchStorefront(
  shopId: string,
  input: StorefrontSearchInput,
  catalog: StorefrontCatalog = getCatalog(),
) {
  const expectedFingerprint = fingerprint(shopId, input);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor && cursor.fingerprint !== expectedFingerprint) throw new InvalidSearchRequestError();
  const result = await catalog.searchProductPage(shopId, {
    query: input.query,
    collection: input.collection,
    category: input.category,
    tag: input.tag,
    available: input.available,
    sort: input.sort,
    limit: input.limit,
    after: cursor ? { sortValue: cursor.sortValue, productId: cursor.productId } : null,
  });
  const last = result.items.at(-1);
  const boundary = result.boundary ?? null;
  const priceSort = input.sort === "price_asc" || input.sort === "price_desc";
  if (result.hasNextPage
    ? !last || !boundary || boundary.productId !== last.id
      || (priceSort ? !Number.isSafeInteger(boundary.sortValue) : typeof boundary.sortValue !== "string")
    : boundary !== null) {
    throw new Error("invalid storefront catalog search page");
  }
  const presentationProducts = result.items.map((product): StoreProduct => {
    const variant = variantFor(product);
    return {
      id: product.id,
      handle: product.handle,
      title: product.title,
      description: capStorefrontCardDescription(product.description),
      images: product.images.slice(0, 1),
      variants: variant ? [variant] : [],
      options: [],
      collections: [],
      category: null,
      tags: [],
    };
  });
  return {
    presentationProducts,
    items: presentationProducts.map((product) => {
      const variant = variantFor(product);
      return {
        id: product.id,
        handle: product.handle,
        title: product.title,
        image: product.images[0] ?? null,
        variantId: variant?.id ?? null,
        priceCents: variant?.hasPrice === false ? null : variant?.priceCents ?? null,
        compareAtPriceCents: variant?.compareAtPriceCents ?? null,
        currency: variant?.currency.toLowerCase() ?? "usd",
        available: available(product),
      };
    }),
    facets: result.facets,
    total: result.total,
    nextCursor: boundary && result.hasNextPage
      ? encodeCursor({
          v: 2,
          sortValue: boundary.sortValue,
          productId: boundary.productId,
          fingerprint: expectedFingerprint,
        })
      : null,
  };
}
