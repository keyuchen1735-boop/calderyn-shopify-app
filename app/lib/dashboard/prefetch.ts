// Idle warm-up for the screen cache: once the shell's shared load has
// settled, fetch each screen's data once in the background so even the FIRST
// visit to a tab paints instantly. Strictly sequential — one request at a
// time — so the warm-up never competes with a user-initiated fetch for
// connection slots. Every entry must use the exact key + payload shape its
// screen caches, or the seed will miss.
import {
  apiGet,
  fetchBilling,
  fetchCollections,
  fetchInventoryList,
  fetchLearnedRules,
  fetchLiveAnalytics,
  fetchLocations,
  fetchProducts,
  fetchPurchaseOrders,
  fetchShipCost,
  fetchUnmatchedShipCharges,
} from "./client";
import { fetchOrdersList, fetchOrdersPage } from "./orders-client";
import { fetchCustomersPage } from "./customers-client";
import { fetchShippingSummary } from "./shipping-client";
import { fetchPaymentsPage } from "./payments-client";
import { fetchStore } from "./store-client";
import { fetchDiscover } from "./discover-client";
import { fetchSearchOverview } from "./search-client";
import { fetchAllPendingTransfers } from "./transfers-client";
import { cachedDraftAuditIds, fetchPoScreen } from "./po-client";
import { fetchCommerceAnalytics } from "./commerce-analytics-client";
import {
  analyticsCacheKey,
  catalogCacheKey,
  prefetchScreenData,
  SCREEN_CACHE_KEYS,
} from "./screen-cache";

// Ordered by how likely the merchant is to open the tab next. Mission
// Control's own fetches (live analytics, default catalog) sit at the end:
// they usually self-warm on mount, so by the time the chain reaches them the
// cache is hot and they cost nothing.
const WARM_TARGETS: Array<[string, () => Promise<unknown>]> = [
  // Home renders the setup-journey card on first paint, so it warms first.
  [SCREEN_CACHE_KEYS.setupProgress, () => apiGet("/dashboard/api/setup-progress")],
  [SCREEN_CACHE_KEYS.orders, fetchOrdersPage],
  // Unified orders list (Phase 2 Task 6), default view only — the screen's own mount fetch reads
  // this exact key/params, so the seed always matches what it would have fetched itself.
  [SCREEN_CACHE_KEYS.ordersList, () => fetchOrdersList({})],
  [analyticsCacheKey(30), () => fetchCommerceAnalytics(30)],
  [SCREEN_CACHE_KEYS.customers, fetchCustomersPage],
  [SCREEN_CACHE_KEYS.shipping, fetchShippingSummary],
  [SCREEN_CACHE_KEYS.payments, fetchPaymentsPage],
  [SCREEN_CACHE_KEYS.billing, fetchBilling],
  [SCREEN_CACHE_KEYS.storeStudio, fetchStore],
  [SCREEN_CACHE_KEYS.discover, fetchDiscover],
  [SCREEN_CACHE_KEYS.search, fetchSearchOverview],
  [SCREEN_CACHE_KEYS.agentic, () => apiGet("/dashboard/api/agentic")],
  [SCREEN_CACHE_KEYS.inventoryList, () => fetchInventoryList({})],
  [SCREEN_CACHE_KEYS.collections, fetchCollections],
  [SCREEN_CACHE_KEYS.transfers, fetchAllPendingTransfers],
  [SCREEN_CACHE_KEYS.locations, fetchLocations],
  // Drafts warm before the PO screen: fetchPoScreen sends the cached drafts'
  // audit ids so the promoted-draft filter warms with real data (best effort).
  [SCREEN_CACHE_KEYS.purchaseOrders, () => fetchPurchaseOrders({})],
  [SCREEN_CACHE_KEYS.po, () => fetchPoScreen(cachedDraftAuditIds())],
  [SCREEN_CACHE_KEYS.shipCost, fetchShipCost],
  [SCREEN_CACHE_KEYS.unmatchedShip, fetchUnmatchedShipCharges],
  [SCREEN_CACHE_KEYS.learnedRules, fetchLearnedRules],
  [SCREEN_CACHE_KEYS.liveAnalytics, fetchLiveAnalytics],
  [catalogCacheKey("", undefined), () => fetchProducts()],
];

/**
 * Best-effort, fire-and-forget. Failures are swallowed inside
 * prefetchScreenData (the owning screen keeps its error UX); a metered
 * connection with Data Saver on skips the warm-up entirely.
 */
export async function warmScreenCaches(): Promise<void> {
  const conn = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  for (const [key, fetcher] of WARM_TARGETS) {
    await prefetchScreenData(key, fetcher);
  }
}
