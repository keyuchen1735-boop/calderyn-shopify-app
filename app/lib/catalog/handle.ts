// app/lib/catalog/handle.ts
// Slugify a collection title into a URL handle. Shared by the server (the
// authoritative write) and the dashboard client (the optimistic row label) so the
// two can't drift. Pure (no server deps) - safe to import from the browser client.
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
