// app/lib/storefront/links.ts
// Storefront link integrity. The store generator (and merchant-authored HTML) emits link hrefs, but
// only a fixed set of storefront routes actually resolve, and collection/product deep links carry a
// handle that must exist in the catalog or the link 404s. normalizeStorefrontHref maps a raw href to
// a guaranteed-live target: an unknown collection/product handle collapses to the shop home
// (/storefront). Everything else — the home, /storefront/cart, in-page #anchors, external http /
// mailto / tel links — passes through untouched.
// ponytail: only the two handle-bearing paths are validated (the hallucination-prone ones); a bogus
// static route like /storefront/nope still slips through. Upgrade path: whitelist static routes too.

export interface StorefrontLinkSet {
  productHandles: Set<string>;
  collectionHandles: Set<string>;
}

const HOME = "/storefront";

/** Return href if it resolves; rewrite an unknown or malformed collection/product deep-link to home. */
export function normalizeStorefrontHref(href: string, links: StorefrontLinkSet): string {
  const raw = href.trim();
  // Collection/product routes are the only storefront paths that carry a catalog handle (and so can
  // 404 on a bad one). Every other href — the home, /storefront/cart, an in-page #anchor, an
  // external / mailto / tel link — is left untouched.
  if (!/^\/storefront\/(collections|products)(?:\/|$)/i.test(raw)) return href;
  // Accept ONLY the exact route shape: /storefront/<kind>/<handle> with an optional trailing slash,
  // query or hash. A missing handle or any extra path segment is not a real route → shop home.
  const m = /^\/storefront\/(collections|products)\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(raw);
  if (!m) return HOME;
  let handle: string;
  try {
    handle = decodeURIComponent(m[2]);
  } catch {
    return HOME; // malformed escape → not a real handle
  }
  const known = m[1].toLowerCase() === "collections" ? links.collectionHandles : links.productHandles;
  return known.has(handle) ? href : HOME;
}
