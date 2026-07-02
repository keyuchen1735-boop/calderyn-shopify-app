// Shared meta helper for storefront child routes: pull the tenant's store name
// out of the storefront layout's loader data (via the meta `matches` argument)
// so page titles carry the merchant's brand, not a hardcoded demo label.
interface LayoutMatch {
  id: string;
  data: unknown;
}

export function storeNameFromMatches(matches: LayoutMatch[]): string {
  const layout = matches.find((m) => m.id === "routes/storefront");
  const name = (layout?.data as { settings?: { storeName?: string } } | undefined)?.settings
    ?.storeName;
  return name || "Calderyn Store";
}
