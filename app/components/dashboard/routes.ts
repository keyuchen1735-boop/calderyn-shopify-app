import type { NavState } from "./context";

// Dedicated-URL map for the dashboard SPA. Every screen and subtab has a
// canonical path under /dashboard so views are deep-linkable and the browser
// back button works. parsePath and pathFor are exact inverses for every
// reachable NavState; unknown paths parse to null and the shell falls back to
// Mission Control with a history.replaceState to the canonical URL.

export const DASHBOARD_BASE = "/dashboard";

export const ORDERS_SUBTABS = ["orders", "labels", "drafts", "abandoned"] as const;
export const ANALYTICS_SUBTABS = ["perf", "live", "pnl"] as const;

function seg(nav: NavState): string {
  const { screen, param, sub } = nav;
  switch (screen) {
    case "dashboard":
      return "";
    case "autopilot":
      return "autopilot";
    case "campaigns":
      return param ? `campaigns/${encodeURIComponent(param)}` : "campaigns";
    case "analytics":
      return sub && sub !== "perf" ? `analytics/${sub}` : "analytics";
    case "search":
      // Merchant SEO/AIO surface, nested under Store as "Preferences".
      return "store/preferences";
    case "orders":
      if (param) return `orders/${encodeURIComponent(param)}`;
      return sub && sub !== "orders" ? `orders/${sub}` : "orders";
    case "catalog":
      return "products";
    case "inventory":
      return "products/inventory";
    case "products-po":
      return "products/po";
    case "products-transfers":
      return "products/transfers";
    case "collections":
      return param ? `products/collections/${encodeURIComponent(param)}` : "products/collections";
    case "locations-settings":
      return "products/locations";
    case "product-editor":
      return `products/${encodeURIComponent(param ?? "new")}`;
    case "customers":
      if (param) return `customers/${encodeURIComponent(param)}`;
      if (sub === "segments") return "customers/segments";
      if (sub === "weather") return "customers/weather";
      return "customers";
    case "shipping":
      return "shipping";
    case "payments":
      return "payments";
    case "storefront":
      return "store";
    case "discover":
      return "store/discover";
    case "alerts":
      return param ? `alerts/${encodeURIComponent(param)}` : "alerts";
    case "audit":
      return "history";
    case "settings":
      return sub && sub !== "general" ? `settings/${sub}` : "settings";
    case "import-shopify":
      return "settings/import";
    case "cutover":
      return "settings/golive";
    case "agentic":
      return "agentic";
    case "labs":
      // Deliberately unaddressed: Labs is the hidden demo behind the secret
      // dot in Settings. It keeps the home URL so it never lands in browser
      // history or autocomplete; a refresh returns to Mission Control.
      return "";
  }
}

export function pathFor(nav: NavState): string {
  const s = seg(nav);
  return s ? `${DASHBOARD_BASE}/${s}` : DASHBOARD_BASE;
}

function is<T extends readonly string[]>(list: T, v: string): v is T[number] {
  return (list as readonly string[]).includes(v);
}

export function parsePath(pathname: string): NavState | null {
  // Split FIRST, decode each segment after — decoding the whole path would
  // turn an encoded "/" inside an id into a bogus extra segment.
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === DASHBOARD_BASE) return { screen: "dashboard", param: null, sub: null };
  if (!path.startsWith(DASHBOARD_BASE + "/")) return null;
  const parts = path.slice(DASHBOARD_BASE.length + 1).split("/").map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg; // Malformed escape — keep raw; ids simply won't match.
    }
  });
  const [a, b, ...rest] = parts;
  if (rest.length > 0) {
    // The one legal three-segment shape: a collection detail URL. Everything
    // else past two segments stays unaddressed.
    if (a === "products" && b === "collections" && rest.length === 1) {
      return { screen: "collections", param: rest[0], sub: null };
    }
    return null;
  }

  switch (a) {
    case "autopilot":
      return b ? null : { screen: "autopilot", param: null, sub: null };
    case "campaigns":
      return { screen: "campaigns", param: b ?? null, sub: null };
    case "analytics":
      if (!b) return { screen: "analytics", param: null, sub: "perf" };
      return is(ANALYTICS_SUBTABS, b) ? { screen: "analytics", param: null, sub: b } : null;
    case "orders":
      if (!b) return { screen: "orders", param: null, sub: "orders" };
      if (is(ORDERS_SUBTABS, b)) return { screen: "orders", param: null, sub: b };
      return { screen: "orders", param: b, sub: null };
    case "products":
      if (!b) return { screen: "catalog", param: null, sub: null };
      if (b === "inventory") return { screen: "inventory", param: null, sub: null };
      if (b === "po") return { screen: "products-po", param: null, sub: null };
      if (b === "transfers") return { screen: "products-transfers", param: null, sub: null };
      if (b === "collections") return { screen: "collections", param: null, sub: null };
      if (b === "locations") return { screen: "locations-settings", param: null, sub: null };
      // Anything else is a product id (or "new") — the editor's inner flow.
      return { screen: "product-editor", param: b, sub: null };
    case "customers":
      if (!b) return { screen: "customers", param: null, sub: "directory" };
      if (b === "segments") return { screen: "customers", param: null, sub: "segments" };
      if (b === "weather") return { screen: "customers", param: null, sub: "weather" };
      return { screen: "customers", param: b, sub: null };
    case "shipping":
      return b ? null : { screen: "shipping", param: null, sub: null };
    case "payments":
      return b ? null : { screen: "payments", param: null, sub: null };
    case "store":
      if (!b) return { screen: "storefront", param: null, sub: null };
      if (b === "discover") return { screen: "discover", param: null, sub: null };
      // Preferences hosts the merchant SEO/AIO (Search) surface.
      if (b === "preferences") return { screen: "search", param: null, sub: null };
      return null;
    case "alerts":
      return { screen: "alerts", param: b ?? null, sub: null };
    case "history":
      return b ? null : { screen: "audit", param: null, sub: null };
    case "settings":
      if (!b) return { screen: "settings", param: null, sub: "general" };
      if (b === "connectors" || b === "mcp") return { screen: "settings", param: null, sub: b };
      if (b === "import") return { screen: "import-shopify", param: null, sub: null };
      if (b === "golive") return { screen: "cutover", param: null, sub: null };
      return null;
    case "agentic":
      return b ? null : { screen: "agentic", param: null, sub: null };
    default:
      return null;
  }
}
