// Session-scoped stale-while-revalidate cache for screen-local dashboard data.
//
// The dashboard SPA keeps shared state (alerts, campaigns, queue…) in the
// shell, but every screen also fetches its own data on mount — so each tab
// visit repainted from a skeleton while the same rows it showed seconds ago
// re-downloaded. Screens now seed their state from this cache (instant paint
// of the last-known data) and keep fetching exactly as before, writing the
// fresh result back through here. The cache is a plain module Map: it lives
// for one page load and is dropped by any full navigation (sign-out, session
// expiry), so it can never leak across accounts.
//
// Semantics are deliberately last-write-wins — the same as the setState calls
// the screens already make. Values are whole endpoint payloads, never partial
// merges.

const cache = new Map<string, unknown>();

// Keys for prefetches that are still in flight, so idle warm-up can't issue
// the same request twice. A direct cacheScreenData write (a screen's own
// fetch landing first) beats a slower prefetch — see prefetchScreenData.
const inflight = new Map<string, Promise<void>>();

/** Last-known payload for a key, or null before the first successful fetch. */
export function cachedScreenData<T>(key: string): T | null {
  return cache.has(key) ? (cache.get(key) as T) : null;
}

/** Write-through after a successful fetch (or an authoritative local update). */
export function cacheScreenData<T>(key: string, value: T): T {
  cache.set(key, value);
  return value;
}

/** Drop everything — tests only; a real session clears by full page load. */
export function clearScreenCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Best-effort warm-up: fetch and cache a key unless it is already cached or
 * being fetched. Failures are swallowed and leave the key cold, so the
 * screen's own fetch (which owns error UX) retries normally. A payload that
 * arrived through cacheScreenData while the prefetch was in flight is fresher
 * and is not overwritten.
 */
export function prefetchScreenData<T>(key: string, fetcher: () => Promise<T>): Promise<void> {
  if (cache.has(key)) return Promise.resolve();
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = fetcher()
    .then((value) => {
      if (!cache.has(key)) cache.set(key, value);
    })
    .catch(() => {
      /* warm-up only — the owning screen surfaces real errors */
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

// ---- shared keys -----------------------------------------------------------
// Single-fetch screens use a plain string; parameterized screens build theirs
// so the same filter always lands on the same entry. Catalog's default key is
// shared with Home's first-run catalog signal (identical request).

export const SCREEN_CACHE_KEYS = {
  liveAnalytics: "live-analytics",
  orders: "orders",
  importedOrders: "imported-orders",
  customers: "customers",
  collections: "collections",
  shipping: "shipping",
  payments: "payments",
  billing: "billing",
  agentic: "agentic",
  storeStudio: "store-studio",
  discover: "discover",
  transfers: "transfers",
  inventorySkus: "inventory-skus",
  locations: "locations",
  shipCost: "settings-ship-cost",
  unmatchedShip: "settings-unmatched-ship",
  learnedRules: "settings-learned-rules",
} as const;

export function catalogCacheKey(search: string, status: string | undefined): string {
  return `catalog:${search}|${status ?? ""}`;
}

export function analyticsCacheKey(days: number): string {
  return `analytics:${days}`;
}
