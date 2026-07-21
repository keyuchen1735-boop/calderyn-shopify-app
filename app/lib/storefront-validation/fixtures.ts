import type { MerchantStorefrontContext } from "../storefront-ai/contracts";
import type { StorefrontRouteId } from "../storefront-bundle/types";
import type { PublicPresentationData, PublicProduct } from "../storefront-runtime/public-data.server";
import { storefrontPolicyLinks, type StorefrontPolicy } from "../storefront/policies.server";

const PROOF_ORIGIN = "https://storefront-proof.local";

export function storefrontProofPolicies(): StorefrontPolicy[] {
  const updatedAt = "2026-07-14T12:00:00.000Z";
  return [
    { id: "privacy", title: "Privacy", body: "Northline uses customer details only to fulfill orders, provide support, prevent fraud, and meet legal obligations.", updatedAt },
    { id: "terms", title: "Terms", body: "Purchases from Northline are subject to the prices, availability, payment terms, and product details shown at checkout.", updatedAt },
    { id: "refund", title: "Refunds", body: "Unused items may be returned within thirty days. Approved refunds are issued to the original payment method.", updatedAt },
    { id: "shipping", title: "Shipping", body: "Available delivery services, charges, and estimated arrival windows are calculated and displayed during checkout.", updatedAt },
  ];
}

function product(index: number, overrides: Partial<PublicProduct> = {}): PublicProduct {
  const available = index !== 2;
  const cents = 2_400 + index * 1_700;
  const image = index === 3 ? null : {
    url: `${PROOF_ORIGIN}/__proof__/catalog/product-${index + 1}.svg`,
    alt: `Studio product ${index + 1} on a neutral backdrop`,
  };
  return {
    id: `proof-product-${index + 1}`,
    handle: `proof-product-${index + 1}`,
    title: index === 0
      ? "The Extraordinarily Long Merchant Product Name for Responsive Typography and Commerce Clarity"
      : `Proof product ${index + 1}`,
    description: index === 0
      ? "A merchant-authored product story with enough detail to exercise long-copy wrapping, readable measure, resilient layout, and purchase clarity. ".repeat(7)
      : "A concise product description grounded in the merchant catalog.",
    primaryImage: image,
    images: image ? [image, { ...image, url: `${PROOF_ORIGIN}/__proof__/catalog/product-${index + 1}-detail.svg`, alt: `Detail view of product ${index + 1}` }] : [],
    options: [{ name: "Finish", values: ["Natural", "Midnight"] }],
    variants: [
      {
        id: `proof-variant-${index + 1}-a`,
        title: "Natural",
        price: { cents, currency: "USD" },
        compareAtPrice: index === 0 ? { cents: cents + 1_100, currency: "USD" } : null,
        availability: available ? "In stock" : "Sold out",
        available,
      },
      {
        id: `proof-variant-${index + 1}-b`,
        title: "Midnight",
        price: { cents: cents + 600, currency: "USD" },
        compareAtPrice: null,
        availability: index === 0 ? "Sold out" : "In stock",
        available: index !== 0,
      },
    ],
    price: { cents, currency: "USD" },
    compareAtPrice: index === 0 ? { cents: cents + 1_100, currency: "USD" } : null,
    availability: available ? "In stock" : "Sold out",
    ...overrides,
  };
}

export function createStorefrontProofData(routeId: StorefrontRouteId): PublicPresentationData {
  const products = [product(0), product(1), product(2), product(3), product(4)];
  const active = products[0];
  return {
    store: { name: "Northline Supply & Studio", logo: null },
    policyLinks: storefrontPolicyLinks(storefrontProofPolicies()),
    product: routeId === "product" ? active : null,
    collection: routeId === "collection" ? {
      id: "proof-collection",
      handle: "proof-collection",
      title: "Objects for Everyday Rituals",
      description: "A collection description that demonstrates how merchant-specific taxonomy and editorial copy adapt inside the selected design system.",
      image: active.primaryImage,
      productCount: products.length,
      products,
      nextCursor: null,
    } : null,
    featuredCollections: [{
      id: "proof-collection",
      handle: "proof-collection",
      title: "Objects for Everyday Rituals",
      description: "A merchant collection.",
      image: active.primaryImage,
      productCount: products.length,
    }],
    featuredProducts: products.slice(0, 4),
    relatedProducts: products.slice(1),
    search: routeId === "search" ? {
      query: "an intentionally unmatched query",
      results: [],
      facets: {
        categories: [{ value: "Objects", count: 4 }],
        tags: [{ value: "Studio", count: 3 }],
        collections: [{ value: "Rituals", count: 5 }],
      },
      total: 0,
      nextCursor: null,
    } : null,
    cart: routeId === "cart" || routeId === "checkout" || routeId === "home" ? {
      id: "proof-cart",
      count: 3,
      lines: [
        { id: "proof-line-1", title: products[0].title, quantity: 1, unitPrice: { cents: 2_400, currency: "USD" }, total: { cents: 2_400, currency: "USD" } },
        { id: "proof-line-2", title: products[1].title, quantity: 2, unitPrice: { cents: 4_100, currency: "USD" }, total: { cents: 8_200, currency: "USD" } },
      ],
      subtotal: { cents: 10_600, currency: "USD" },
      discounts: { cents: 1_000, currency: "USD" },
      total: { cents: 9_600, currency: "USD" },
    } : null,
    notFound: null,
  };
}

export function storefrontProofContext(productCount = 61): MerchantStorefrontContext {
  return {
    version: 1,
    prompt: "Create an original product-first storefront for Northline Supply & Studio",
    promptHash: "sha256:storefront-browser-proof",
    referenceImages: [],
    store: { name: "Northline Supply & Studio", logoAssetKey: null, publicBrandAssetKeys: [] },
    collections: [
      { id: "collection-001", handle: "proof-collection", title: "Objects for Everyday Rituals", productCount },
      { id: "collection-002", handle: "new-studio-work", title: "New Studio Work", productCount: Math.ceil(productCount / 2) },
      { id: "collection-003", handle: "archive-materials", title: "Archive Materials", productCount: Math.floor(productCount / 2) },
    ],
    products: Array.from({ length: productCount }, (_, index) => ({
      id: `product-${String(index + 1).padStart(3, "0")}`,
      handle: `proof-product-${index + 1}`,
      title: product(index).title,
      productType: "Studio object",
      tags: ["studio", index === 2 ? "sold-out" : "available"],
      optionNames: ["Finish"],
      priceMin: product(index).price?.cents ?? 0,
      priceMax: (product(index).price?.cents ?? 0) + 600,
      currency: "USD",
      availability: index === 2 ? "sold_out" : index === 0 ? "mixed" : "available",
      collectionIds: ["collection-001", index % 2 === 0 ? "collection-002" : "collection-003"],
      images: (productCount === 61 ? index >= 51 : index === 3)
        ? []
        : [{ assetKey: `catalog-product-${index + 1}`, aspectRatio: 1.25 }],
    })),
    reusableAssets: [],
    recipeNoveltySignatures: [],
    fingerprint: "sha256:storefront-browser-proof-context",
  };
}
