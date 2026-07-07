// Pure schema.org node builders. No I/O — everything is derived from its arguments so
// the shapes are validated by unit tests and safe to serialize into <script type="application/ld+json">.
import type { JsonLd } from "./types";

const CTX = "https://schema.org" as const;
const money = (cents: number) => (cents / 100).toFixed(2);
const availability = (available: boolean) =>
  available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";

export function offerNode(i: { priceCents: number; currency: string; available: boolean; sku?: string | null; url: string }): JsonLd {
  const node: JsonLd = {
    "@context": CTX, "@type": "Offer",
    price: money(i.priceCents), priceCurrency: i.currency,
    availability: availability(i.available), url: i.url,
  };
  if (i.sku) node.sku = i.sku;
  return node;
}

export function aggregateOfferNode(i: { lowCents: number; highCents: number; currency: string; offerCount: number; anyAvailable: boolean }): JsonLd {
  return {
    "@context": CTX, "@type": "AggregateOffer",
    lowPrice: money(i.lowCents), highPrice: money(i.highCents),
    priceCurrency: i.currency, offerCount: i.offerCount,
    availability: availability(i.anyAvailable),
  };
}

export function productJsonLd(i: { name: string; description: string; url: string; images: string[]; offers: JsonLd | null }): JsonLd {
  const node: JsonLd = {
    "@context": CTX, "@type": "Product",
    name: i.name, description: i.description, url: i.url, image: i.images,
  };
  if (i.offers) node.offers = i.offers;
  return node;
}

export function organizationJsonLd(i: { name: string; url: string; logo?: string | null; description?: string | null }): JsonLd {
  const node: JsonLd = { "@context": CTX, "@type": "Organization", name: i.name, url: i.url };
  if (i.logo) node.logo = i.logo;
  if (i.description) node.description = i.description;
  return node;
}

export function webSiteJsonLd(i: { name: string; url: string }): JsonLd {
  return { "@context": CTX, "@type": "WebSite", name: i.name, url: i.url };
}

export function collectionJsonLd(i: { name: string; url: string; description?: string | null }): JsonLd {
  const node: JsonLd = { "@context": CTX, "@type": "CollectionPage", name: i.name, url: i.url };
  if (i.description) node.description = i.description;
  return node;
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]): JsonLd {
  return {
    "@context": CTX, "@type": "BreadcrumbList",
    itemListElement: items.map((it, idx) => ({
      "@type": "ListItem", position: idx + 1, name: it.name, item: it.url,
    })),
  };
}
