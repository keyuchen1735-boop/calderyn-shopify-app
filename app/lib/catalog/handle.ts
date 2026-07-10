// app/lib/catalog/handle.ts
// Slugify a collection title into a URL handle. Shared by the server (the
// authoritative write) and the dashboard client (the optimistic row label) so the
// two can't drift. Pure (no server deps) - safe to import from the browser client.

// The product-handle contract, shared by the server validator (validate.ts) and
// the editor's pre-submit check so the two can't drift: lowercase slug segments
// joined by single hyphens (no leading/trailing/double hyphen), 1-80 chars.
export const PRODUCT_HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PRODUCT_HANDLE_MAX = 80;
export function collectionHandle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "collection"
  );
}

// Base slug of a product handle — the server's authoritative handle is this
// plus a random suffix (catalog.server.ts productHandle), so previews built
// from it share the exact slug rules and can't drift.
export function productHandleBase(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "product"
  );
}
