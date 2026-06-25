// Manual deep-links for action kinds that have no one-click executor. Keeps an
// advisory row actionable — a real link to where the merchant does it manually —
// instead of a dead/erroring button (rule 12). Pure; safe to import from client
// and server. The href is built at render time where the shop is known.

/** Build a shop-scoped Shopify admin URL from the myshopify domain. */
export function shopifyAdminUrl(shop: string, path: string): string {
  return `https://${shop}/admin/${path.replace(/^\/+/, "")}`;
}

/**
 * The manual destination for an action kind with no executor, or null when the
 * kind has a real one-click executor (so callers fall back to the button). Free
 * shipping has no clean per-product/threshold API in Shopify — the honest action
 * is a deep-link into Shipping settings.
 */
export function actionDeepLink(
  kind: string,
  shop: string,
): { label: string; href: string } | null {
  switch (kind) {
    case "raise_free_ship_threshold":
    case "exclude_sku_free_ship":
      return { label: "Open Shipping settings", href: shopifyAdminUrl(shop, "settings/shipping") };
    default:
      return null;
  }
}

/** Whether a kind has a manual deep-link (i.e. no one-click executor). Shop-agnostic. */
export function hasActionDeepLink(kind: string): boolean {
  return actionDeepLink(kind, "_") !== null;
}
