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
