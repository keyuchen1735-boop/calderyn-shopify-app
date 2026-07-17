import type { DataRequirement, StorefrontRouteId } from "~/lib/storefront-bundle/types";
import type { StorefrontCatalog, StoreProduct, StoreVariant } from "~/lib/storefront/catalog";
import { selectStorefrontPriceVariant } from "~/lib/storefront/catalog";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings, type StoreSettings } from "~/lib/storefront/settings.server";
import { loadStorefrontPolicyLinks } from "~/lib/storefront/policies.server";
import {
  parseStorefrontSearchParams,
  searchStorefront,
  type StorefrontSearchInput,
} from "~/lib/storefront/search.server";

export interface PublicMoney {
  cents: number;
  currency: string;
}

export interface PublicMedia {
  url: string;
  alt: string | null;
}

export interface PublicVariant {
  id: string;
  title: string;
  price: PublicMoney | null;
  compareAtPrice: PublicMoney | null;
  availability: "In stock" | "Sold out";
  available: boolean;
}

export interface PublicProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  primaryImage: PublicMedia | null;
  images: PublicMedia[];
  options: Array<{ name: string; values: string[] }>;
  variants: PublicVariant[];
  price: PublicMoney | null;
  compareAtPrice: PublicMoney | null;
  availability: "In stock" | "Sold out";
}

export interface PublicCollection {
  id: string;
  handle: string;
  title: string;
  description: string;
  image: PublicMedia | null;
  productCount: number;
  products: PublicProduct[];
  nextCursor: string | null;
}

export interface PublicCart {
  id: string;
  count: number;
  lines: Array<{
    id: string;
    title: string;
    quantity: number;
    unitPrice: PublicMoney;
    total: PublicMoney;
  }>;
  subtotal: PublicMoney;
  discounts: PublicMoney;
  total: PublicMoney;
}

export interface PublicPresentationData {
  store: { name: string; logo: string | null };
  storefrontAssetUrls?: Readonly<Record<string, string>>;
  policyLinks: Array<{ id: string; title: string; href: string }>;
  product: PublicProduct | null;
  collection: PublicCollection | null;
  featuredProducts: PublicProduct[];
  relatedProducts: PublicProduct[];
  search: {
    query: string;
    results: PublicProduct[];
    facets: {
      categories: Array<{ value: string; count: number }>;
      tags: Array<{ value: string; count: number }>;
      collections: Array<{ value: string; count: number }>;
    };
    total: number;
    nextCursor: string | null;
  } | null;
  cart: PublicCart | null;
  notFound: { kind: "product" | "collection"; handle: string } | null;
}

export type PublicRouteContext =
  | { kind: "home" | "cart" | "checkout" }
  | { kind: "product"; handle: string }
  | { kind: "collection"; handle: string; searchInput?: StorefrontSearchInput }
  | { kind: "search"; query: string; searchInput?: StorefrontSearchInput };

export interface ResolvePublicDataInput {
  shopId: string;
  requiredData: readonly DataRequirement[];
  route: PublicRouteContext;
  featuredProductIds?: readonly string[];
}

export interface PublicDataDependencies {
  catalog?: StorefrontCatalog;
  settingsLoader?: (shopId: string) => Promise<StoreSettings>;
  policyLoader?: (shopId: string) => Promise<PublicPresentationData["policyLinks"]>;
  cartLoader?: (shopId: string) => Promise<PublicCart | null>;
  searchLoader?: typeof searchStorefront;
}

const LIMITS = {
  featuredProducts: 12,
  relatedProducts: 8,
  searchResults: 24,
} as const;

const CLOSED_KINDS = new Set<DataRequirement["kind"]>([
  "storeIdentity", "policyLinks", "currentProduct", "currentCollection", "cart",
  "featuredProducts", "relatedProducts", "searchResults",
]);

export class PublicDataPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicDataPlanError";
  }
}

function validatePlan(requiredData: readonly DataRequirement[]): void {
  if (requiredData.length > 12) throw new PublicDataPlanError("requiredData exceeds the closed plan budget");
  for (const requirement of requiredData) {
    if (!CLOSED_KINDS.has(requirement.kind)) {
      throw new PublicDataPlanError(`Unsupported data requirement ${String(requirement.kind)}`);
    }
    if (requirement.kind in LIMITS) {
      const capped = LIMITS[requirement.kind as keyof typeof LIMITS];
      const limit = (requirement as { limit?: unknown }).limit;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > capped) {
        throw new PublicDataPlanError(`${requirement.kind} limit must be between 1 and ${capped}`);
      }
    }
  }
}

function money(variant: StoreVariant, field: "priceCents" | "compareAtPriceCents"): PublicMoney | null {
  if (variant.hasPrice === false) return null;
  const cents = variant[field];
  return typeof cents === "number" ? { cents, currency: variant.currency } : null;
}

function presentProduct(product: StoreProduct): PublicProduct {
  const variants = product.variants.map((variant): PublicVariant => ({
    id: variant.id,
    title: variant.title,
    price: money(variant, "priceCents"),
    compareAtPrice: money(variant, "compareAtPriceCents"),
    availability: variant.available ? "In stock" : "Sold out",
    available: variant.available,
  }));
  const selectedId = selectStorefrontPriceVariant(product)?.id;
  const selected = variants.find((variant) => variant.id === selectedId) ?? null;
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    description: product.description,
    primaryImage: product.images[0] ?? null,
    images: product.images.map((image) => ({ url: image.url, alt: image.alt })),
    options: (product.options ?? []).map((option) => ({ name: option.name, values: [...option.values] })),
    variants,
    price: selected?.price ?? null,
    compareAtPrice: selected?.compareAtPrice ?? null,
    availability: variants.some((variant) => variant.available) ? "In stock" : "Sold out",
  };
}

function baseData(settings: StoreSettings): PublicPresentationData {
  return {
    store: { name: settings.storeName, logo: settings.logoUrl },
    policyLinks: [],
    product: null,
    collection: null,
    featuredProducts: [],
    relatedProducts: [],
    search: null,
    cart: null,
    notFound: null,
  };
}

function hasRequirement(input: ResolvePublicDataInput, kind: DataRequirement["kind"]): boolean {
  return input.requiredData.some((requirement) => requirement.kind === kind);
}

async function fullSearchProducts(
  shopId: string,
  catalog: StorefrontCatalog,
  searchInput: StorefrontSearchInput,
  limit: number,
  searchLoader: typeof searchStorefront,
) {
  const result = await searchLoader(shopId, searchInput, catalog);
  return {
    result,
    products: result.presentationProducts.slice(0, limit).map(presentProduct),
  };
}

export async function resolvePublicData(
  input: ResolvePublicDataInput,
  dependencies: PublicDataDependencies = {},
): Promise<PublicPresentationData> {
  validatePlan(input.requiredData);
  const catalog = dependencies.catalog ?? getCatalog();
  const settings = await (dependencies.settingsLoader ?? getStoreSettings)(input.shopId);
  const data = baseData(settings);

  if (hasRequirement(input, "policyLinks")) {
    data.policyLinks = await (dependencies.policyLoader ?? loadStorefrontPolicyLinks)(input.shopId);
  }

  let rawCurrentProduct: StoreProduct | null = null;
  if (hasRequirement(input, "currentProduct") || hasRequirement(input, "relatedProducts")) {
    if (input.route.kind !== "product") throw new PublicDataPlanError("currentProduct requires a product route");
    rawCurrentProduct = await catalog.getProduct(input.shopId, input.route.handle);
    data.product = rawCurrentProduct ? presentProduct(rawCurrentProduct) : null;
    if (!rawCurrentProduct) data.notFound = { kind: "product", handle: input.route.handle };
  }

  if (hasRequirement(input, "currentCollection")) {
    if (input.route.kind !== "collection") throw new PublicDataPlanError("currentCollection requires a collection route");
    const collectionHandle = input.route.handle;
    if (!catalog.getCollection) throw new PublicDataPlanError("Catalog does not support bounded collection lookup");
    const collection = await catalog.getCollection(input.shopId, collectionHandle);
    if (!collection) {
      data.notFound = { kind: "collection", handle: collectionHandle };
    } else {
      const defaultParams = new URLSearchParams({ collection: collection.handle, limit: "24" });
      const searchInput = input.route.searchInput ?? parseStorefrontSearchParams(defaultParams);
      const searched = await fullSearchProducts(
        input.shopId,
        catalog,
        searchInput,
        24,
        dependencies.searchLoader ?? searchStorefront,
      );
      data.collection = {
        id: collection.id ?? collection.handle,
        handle: collection.handle,
        title: collection.title,
        description: collection.description ?? "",
        image: searched.products[0]?.primaryImage ?? null,
        productCount: searched.result.total,
        products: searched.products,
        nextCursor: searched.result.nextCursor,
      };
    }
  }

  for (const requirement of input.requiredData) {
    if (requirement.kind === "featuredProducts") {
      const featuredIds = input.route.kind === "home"
        ? input.featuredProductIds?.slice(0, requirement.limit)
        : undefined;
      const products = await catalog.listProducts(input.shopId, {
        ...(featuredIds?.length
          ? { ids: [...featuredIds] }
          : requirement.collectionHandle ? { collection: requirement.collectionHandle } : {}),
        limit: featuredIds?.length ?? requirement.limit,
      });
      if (featuredIds?.length) {
        const byId = new Map(products.map((product) => [product.id, product]));
        data.featuredProducts = featuredIds.flatMap((id) => {
          const product = byId.get(id);
          return product ? [presentProduct(product)] : [];
        });
      } else {
        data.featuredProducts = products.slice(0, requirement.limit).map(presentProduct);
      }
    } else if (requirement.kind === "relatedProducts") {
      if (!rawCurrentProduct) data.relatedProducts = [];
      else {
        const products = await catalog.listProducts(input.shopId, { limit: requirement.limit + 1 });
        data.relatedProducts = products
          .filter((entry) => entry.id !== rawCurrentProduct?.id)
          .slice(0, requirement.limit)
          .map(presentProduct);
      }
    } else if (requirement.kind === "searchResults") {
      const query = input.route.kind === "search" ? input.route.query.slice(0, 200) : "";
      const searchInput = input.route.kind === "search" && input.route.searchInput
        ? input.route.searchInput
        : parseStorefrontSearchParams(new URLSearchParams({
          ...(query ? { q: query } : {}),
          limit: String(requirement.limit),
        }));
      const searched = await fullSearchProducts(
        input.shopId,
        catalog,
        searchInput,
        requirement.limit,
        dependencies.searchLoader ?? searchStorefront,
      );
      data.search = {
        query: searchInput.query,
        results: searched.products,
        facets: searched.result.facets,
        total: searched.result.total,
        nextCursor: searched.result.nextCursor,
      };
    } else if (requirement.kind === "cart") {
      data.cart = await (dependencies.cartLoader?.(input.shopId) ?? Promise.resolve(null));
    }
  }
  return data;
}

export function routeIdForPublicContext(route: PublicRouteContext): StorefrontRouteId {
  return route.kind;
}
