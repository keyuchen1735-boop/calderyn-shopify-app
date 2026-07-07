// The Home "Set up your store" checklist tracks the three milestones that gate
// selling: account (done at signup), a first product, and live payouts. The
// card must stay until ALL three are met. The regression it guards against: the
// old gate hid the whole card the instant a product existed, so a merchant who
// created a product but had not connected payouts lost the guide (and the
// Connect-payouts step with it) after a single navigation away and back.
import { afterEach, describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import Dashboard from "../Dashboard";
import type { DashboardCtx } from "../../context";
import type { BillingStatus } from "~/lib/dashboard/client";
import { cacheScreenData, clearScreenCache, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";

function makeCtx(overrides: Partial<DashboardCtx>): DashboardCtx {
  return {
    t: {},
    shopDomain: "test.myshopify.com",
    storeLabel: "test.myshopify.com",
    orgSlug: null,
    demoMode: false,
    canDeleteAccount: false,
    hasCatalog: true,
    nav: { screen: "dashboard", param: null, sub: null },
    navigate: () => {},
    setNightMode: () => {},
    alerts: [],
    campaigns: [],
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
    liveOn: true,
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

function seedBilling(status: Partial<BillingStatus>): void {
  cacheScreenData<BillingStatus>(SCREEN_CACHE_KEYS.billing, {
    connected: false,
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    ...status,
  } as BillingStatus);
}

const ACTIVE_PAYOUTS = {
  connected: true,
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
};

describe("Home setup checklist gating", () => {
  afterEach(() => clearScreenCache());

  it("keeps the setup card when a product exists but payouts are NOT connected (the regression)", () => {
    seedBilling({ connected: false }); // billing known, not active
    const html = renderToString(h(Dashboard, { app: makeCtx({ hasCatalog: true }) }));
    expect(html).toContain("Set up your store");
    // Product step reads as done; payouts step is still the actionable one.
    expect(html).toContain("Add your first product");
    expect(html).toContain("Stripe, about two minutes.");
    // Account + product done, payouts outstanding.
    expect(html).toContain("2 of 3");
  });

  it("hides the setup card only once BOTH a product and live payouts exist", () => {
    seedBilling(ACTIVE_PAYOUTS);
    const html = renderToString(h(Dashboard, { app: makeCtx({ hasCatalog: true }) }));
    expect(html).not.toContain("Set up your store");
  });

  it("a store with products but active payouts unknown does not flash the guide on cold load", () => {
    // No billing seeded → payouts state unknown. An established store must not
    // have the checklist forced open before its billing status is even read.
    const html = renderToString(h(Dashboard, { app: makeCtx({ hasCatalog: true }) }));
    expect(html).not.toContain("Set up your store");
  });

  it("a brand-new store still shows the guide immediately, counting only the account step", () => {
    const html = renderToString(h(Dashboard, { app: makeCtx({ hasCatalog: false, loading: true, booted: false }) }));
    expect(html).toContain("Set up your store");
    expect(html).toContain("Describe your first product");
    expect(html).toContain("1 of 3");
  });
});
