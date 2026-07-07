// Deterministic SEO/AIO draft writer: given owned catalog + store settings, produce a SeoDraft.
// No Claude dependency — templated output keyed to the product's own words, safe on the hot path.
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";
import type { JsonLd, SeoDraft } from "./types";
import { plainText, clampText, clampTitle } from "./text";
import { sellableVariants, sellablePrice } from "./pricing";
import {
  productJsonLd, offerNode, aggregateOfferNode, organizationJsonLd, webSiteJsonLd, collectionJsonLd, breadcrumbJsonLd,
} from "./jsonld.server";

export { plainText, clampText } from "./text";

const DESC_MAX = 155;

function productDescription(product: StoreProduct, store: StoreSettings): string {
  const body = plainText(product.description);
  if (body) return clampText(body, DESC_MAX);
  // A brand-new product with no description still needs a natural, human-readable
  // line that clears the 50-char health floor, so a fresh catalog reads healthy.
  return clampText(
    `${product.title} from ${store.storeName}. See the details, pricing, and current availability, then order online.`,
    DESC_MAX,
  );
}

function buildOffers(product: StoreProduct, url: string): JsonLd | null {
  const sellable = sellableVariants(product);
  if (sellable.length === 0) return null;
  const { priceCents: low, currency, available } = sellablePrice(product);
  const high = Math.max(...sellable.map((v) => v.priceCents));
  if (low === high) {
    return offerNode({ priceCents: low, currency, available, sku: sellable[0].sku, url });
  }
  return aggregateOfferNode({ lowCents: low, highCents: high, currency, offerCount: sellable.length, anyAvailable: available });
}

// Store-description hard cap: mirrors the seo_settings org_description bound so a
// suggested line is always within what the field + server will accept.
const STORE_DESC_MAX = 200;

// Join a short list into natural prose: "A", "A and B", "A, B, and C".
function listPhrase(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Deterministic one-line store description tuned for search + AI answers: names
 *  the store and what it sells (from collection or product names), then folds in
 *  the store's own tagline. No Claude dependency — a merchant can then edit it.
 *  `subjects` should be the store's collection titles, falling back to a few
 *  product titles when the catalog has no collections. */
export function buildStoreDescription(store: StoreSettings, subjects: string[]): string {
  const name = store.storeName.trim() || "This store";
  const tagline = plainText(store.voiceTagline ?? "").trim();
  const seen = new Set<string>();
  const picks = subjects
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, 3);

  const opener = picks.length ? `${name} sells ${listPhrase(picks)}.` : `${name} is an online store.`;
  // A tagline that just repeats the store name adds nothing; only append real copy.
  const closer =
    tagline && !tagline.toLowerCase().includes(name.toLowerCase())
      ? /[.!?]$/.test(tagline)
        ? tagline
        : `${tagline}.`
      : "Shop the full range online.";
  return clampText(`${opener} ${closer}`, STORE_DESC_MAX);
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
