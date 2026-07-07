// Deterministic SEO/AIO draft writer: given owned catalog + store settings, produce a SeoDraft.
// No Claude dependency — templated output keyed to the product's own words, safe on the hot path.
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";
import type { JsonLd, SeoDraft } from "./types";
import { plainText, clampText, clampTitle } from "./text";
import {
  productJsonLd, offerNode, aggregateOfferNode, organizationJsonLd, webSiteJsonLd, collectionJsonLd, breadcrumbJsonLd,
} from "./jsonld.server";

export { plainText, clampText } from "./text";

const DESC_MAX = 155;

function productDescription(product: StoreProduct, store: StoreSettings): string {
  const body = plainText(product.description);
  if (body) return clampText(body, DESC_MAX);
  return clampText(`${product.title} from ${store.storeName}.`, DESC_MAX);
}

function buildOffers(product: StoreProduct, url: string): JsonLd | null {
  const sellable = product.variants.filter((v) => v.priceCents > 0);
  if (sellable.length === 0) return null;
  const currency = sellable[0].currency;
  const anyAvailable = sellable.some((v) => v.available);
  const prices = sellable.map((v) => v.priceCents);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  if (low === high) {
    const v = sellable[0];
    return offerNode({ priceCents: v.priceCents, currency, available: anyAvailable, sku: v.sku, url });
  }
  return aggregateOfferNode({ lowCents: low, highCents: high, currency, offerCount: sellable.length, anyAvailable });
}

export function buildProductDraft(product: StoreProduct, store: StoreSettings, origin: string): SeoDraft {
  const canonical = `${origin}/storefront/products/${product.handle}`;
  const description = productDescription(product, store);
  const imageAlts = product.images.map((img) => img.alt?.trim() || `${product.title}, ${store.storeName}`);
  const offers = buildOffers(product, canonical);
  const jsonLd: JsonLd[] = [
    productJsonLd({ name: product.title, description, url: canonical, images: product.images.map((i) => i.url), offers }),
    breadcrumbJsonLd([
      { name: store.storeName, url: `${origin}/storefront` },
      { name: product.title, url: canonical },
    ]),
  ];
  return {
    title: clampTitle(product.title, store.storeName),
    description,
    canonical,
    ogImage: product.images[0]?.url ?? store.logoUrl ?? null,
    ogType: "product",
    imageAlts,
    jsonLd,
  };
}

export function buildHomeDraft(store: StoreSettings, origin: string): SeoDraft {
  const canonical = `${origin}/storefront`;
  const description = clampText(store.voiceTagline?.trim() || `Browse ${store.storeName}.`, DESC_MAX);
  return {
    title: clampText(store.storeName, 60),
    description,
    canonical,
    ogImage: store.logoUrl ?? null,
    ogType: "website",
    imageAlts: [],
    jsonLd: [
      organizationJsonLd({ name: store.storeName, url: canonical, logo: store.logoUrl, description: store.voiceTagline }),
      webSiteJsonLd({ name: store.storeName, url: canonical }),
    ],
  };
}

export function buildCollectionDraft(
  collection: { handle: string; title: string; description?: string | null },
  store: StoreSettings,
  origin: string,
): SeoDraft {
  const canonical = `${origin}/storefront/collections/${collection.handle}`;
  const description = clampText(
    (collection.description && plainText(collection.description)) || `${collection.title} from ${store.storeName}.`,
    DESC_MAX,
  );
  return {
    title: clampTitle(collection.title, store.storeName),
    description,
    canonical,
    ogImage: store.logoUrl ?? null,
    ogType: "website",
    imageAlts: [],
    jsonLd: [
      collectionJsonLd({ name: collection.title, url: canonical, description }),
      breadcrumbJsonLd([
        { name: store.storeName, url: `${origin}/storefront` },
        { name: collection.title, url: canonical },
      ]),
    ],
  };
}
