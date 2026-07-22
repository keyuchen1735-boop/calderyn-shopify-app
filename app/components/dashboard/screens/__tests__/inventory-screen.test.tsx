// The Inventory screen must paint real balance data from the seeded session
// cache (instant return-visit paint) and surface Autopilot restock presence on
// low/out rows — this smoke test locks both onto the static markup.
import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Inventory from "../Inventory";
import {
  cacheScreenData,
  clearScreenCache,
  SCREEN_CACHE_KEYS,
} from "~/lib/dashboard/screen-cache";
import type { InventoryRowVM } from "~/lib/dashboard/client";
import type { DashboardCtx } from "../../context";

// No network in this test (vi.mock hoists above the imports): the screen's
// mount fetch never resolves, so the markup can only come from the seeded
// screen cache.
vi.mock("~/lib/dashboard/client", () => ({
  DashboardApiError: class DashboardApiError extends Error {},
  fetchInventoryList: () => new Promise(() => {}),
  setOnHand: () => new Promise(() => {}),
  fetchVariantInventory: () => new Promise(() => {}),
  fetchPendingTransfers: () => new Promise(() => {}),
  fetchLocations: () => new Promise(() => {}),
}));

function makeApp(overrides: Partial<DashboardCtx> = {}): DashboardCtx {
  return {
    t: {},
    shopDomain: null,
    storeLabel: "Acme",
    orgSlug: null,
    demoMode: false,
    canDeleteAccount: false,
    hasCatalog: true,
    nav: { screen: "inventory", param: null, sub: null },
    navigate: () => {},
    setNightMode: () => {},
    alerts: [],
    campaigns: [],
    campaignReport: { window: 30, campaigns: [], status: "ready", targetWindow: null, error: null, requestId: null },
    audit: [],
    guardrails: null,
    integrations: [],
    setIntegrations: () => {},
    consent: null,
    overview: null,
    calibration: null,
    actionQueue: [],
    liveEngine: null,
    feed: [],
    liveOn: false,
    setLiveOn: () => {},
    executeAction: async () => ({ ok: true, receipt: null }),
    weatherIntent: async () => true,
    undoAction: () => {},
    pushAdDraft: () => {},
    toast: () => {},
    relTime: () => "",
    refresh: () => {},
    refreshCalibration: () => {},
    openAssistant: () => {},
    refreshLiveEngine: () => {},
    loading: false,
    booted: true,
    ...overrides,
  };
}

const ROWS: InventoryRowVM[] = [
  {
    variantId: "v1",
    productId: "p1",
    sku: "SKU-1",
    variantTitle: null,
    productTitle: "Trail Tee",
    onHand: 0,
    reserved: 0,
    incoming: 0,
    available: 0,
    low: true,
    locationCount: 1,
    singleLocationId: "loc-1",
    restock: { auditId: "a1", createdAt: new Date().toISOString(), outcome: "executed" },
  },
  {
    variantId: "v2",
    productId: "p2",
    sku: "SKU-2",
    variantTitle: "M",
    productTitle: "Camp Mug",
    onHand: 12,
    reserved: 1,
    incoming: 0,
    available: 11,
    low: false,
    locationCount: 2,
    singleLocationId: null,
    restock: null,
  },
];

describe("Inventory screen", () => {
  it("renders the header and a loading skeleton with a cold cache", () => {
    clearScreenCache();
    const html = renderToStaticMarkup(h(Inventory, { app: makeApp() }));
    expect(html).toContain("Products");
    expect(html).toContain("cd-skel");
  });

  it("paints seeded rows with stock status and Autopilot restock presence", () => {
    clearScreenCache();
    cacheScreenData(SCREEN_CACHE_KEYS.inventoryList, { rows: ROWS, total: 2 });
    const html = renderToStaticMarkup(h(Inventory, { app: makeApp() }));
    expect(html).toContain("Out of stock");
    expect(html).toContain("Restock draft");
    expect(html).toContain("Trail Tee");
    expect(html).toContain("Healthy");
    // The healthy row carries no restock audit, so it must not fake presence.
    expect(html.match(/Restock draft/g)?.length).toBe(1);
  });
});
