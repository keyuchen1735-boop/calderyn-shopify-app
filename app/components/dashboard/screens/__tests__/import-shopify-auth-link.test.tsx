// Shopify OAuth must start on the public dashboard origin. If an owned-store
// dashboard renders a relative /dashboard/login link from app.*, the callback
// lands on the apex without the state cookie and shows oauth_failed.
import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ImportShopify from "../ImportShopify";
import WelcomeOverlay from "../../store/WelcomeOverlay";
import type { DashboardCtx } from "../../context";

function makeApp(overrides: Partial<DashboardCtx> = {}): DashboardCtx {
  return {
    t: {},
    shopDomain: null,
    storeLabel: "Acme",
    orgSlug: null,
    demoMode: false,
    canDeleteAccount: false,
    hasCatalog: false,
    nav: { screen: "import-shopify", param: null, sub: null },
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

describe("Shopify connect links from dashboard screens", () => {
  it("starts the import screen OAuth flow on the public apex", () => {
    const html = renderToStaticMarkup(
      h(ImportShopify, { app: makeApp({ authBase: "https://calderyncompany.com" }) }),
    );
    expect(html).toContain('href="https://calderyncompany.com/dashboard/login"');
    expect(html).not.toContain('href="/dashboard/login"');
  });

  it("starts the store welcome OAuth flow on the public apex", () => {
    const html = renderToStaticMarkup(
      h(WelcomeOverlay, {
        authBase: "https://calderyncompany.com",
        branch: { kind: "empty" },
        importRun: null,
        buildPhase: null,
        productCount: 0,
        onBuildPrompt: () => {},
        onAddProduct: () => {},
      }),
    );
    expect(html).toContain('href="https://calderyncompany.com/dashboard/login"');
    expect(html).not.toContain('href="/dashboard/login"');
  });
});
