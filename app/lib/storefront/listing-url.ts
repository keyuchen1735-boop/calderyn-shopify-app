// Builds the storefront listing URL shown in the new-product preview. Client-safe
// (pure): uses the tenant's real org_slug and the /storefront path the subdomain
// actually serves, so the previewed link resolves to the live store instead of a
// re-derived slug that 404s. The product handle is best-effort pre-save — the
// stored handle gains a unique suffix at save time (see productHandleBase).
import { productHandleBase } from "~/lib/catalog/handle";

const TENANT_ZONE = "calderyncompany.com";

// Only used when a tenant has no org_slug yet (legacy Shopify sessions, which
// don't have a native storefront anyway). Not authoritative — the real slug
// carries dashes + a unique suffix.
function fallbackSlug(storeLabel: string): string {
  return (
    storeLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "your-store"
  );
}

export function storefrontListingUrl(
  orgSlug: string | null,
  storeLabel: string,
  title: string,
): string {
  const slug = orgSlug || fallbackSlug(storeLabel);
  return `${slug}.${TENANT_ZONE}/storefront/products/${productHandleBase(title)}`;
}
