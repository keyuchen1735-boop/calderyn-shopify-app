// First-paint contract for Home. The dashboard SSRs before any data fetch, so
// the pre-fetch render decides what a merchant sees for the first seconds of
// every cold load. The loader's `hasCatalog` hint (a product-existence probe)
// tells the screen which layout it is loading INTO, so the server render must
// already be the right page:
//   established store → metrics strip + deck skeleton + pending gauge — never
//     a void, never a fake "All clear", never a lit "0%" calibration readout;
//   fresh store → the setup guide, immediately.
import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import Dashboard from "../Dashboard";
import type { DashboardCtx } from "../../context";

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
    undoAction: () => {},
    pushAdDraft: () => {},
    toast: () => {},
    relTime: () => "",
    refresh: () => {},
    refreshCalibration: () => {},
    openAssistant: () => {},
    refreshLiveEngine: () => {},
    loading: true,
    booted: false,
    ...overrides,
  };
}

describe("Home first paint (pre-fetch SSR)", () => {
  it("an established store paints its real layout: strip, deck skeleton, no false empty-states", () => {
    const html = renderToString(h(Dashboard, { app: makeCtx({ hasCatalog: true, loading: true }) }));
    expect(html).toContain("Sales · today"); // metrics strip is present (dash values)
    expect(html).toContain("cd-deck"); // deck area reserved
    expect(html).toContain("cd-skel-bar"); // …as a loading skeleton
    expect(html).not.toContain("All clear"); // never claim an empty queue before it loaded
    expect(html).not.toContain("Set up your store");
  });

  it("shows a pending gauge readout while calibration is unknown — not a lit 0%", () => {
    const html = renderToString(h(Dashboard, { app: makeCtx({ hasCatalog: true, loading: true }) }));
    expect(html).toContain("<b>—</b>");
    expect(html).not.toContain("<b>0</b>");
  });

  it("a fresh store paints the setup guide immediately", () => {
    const html = renderToString(h(Dashboard, { app: makeCtx({ hasCatalog: false, loading: true }) }));
    expect(html).toContain("Set up your store");
    expect(html).toContain("Welcome.");
    expect(html).not.toContain("Sales · today");
  });

  it("once a load fully succeeds, an empty queue is an honest All clear (no skeleton left)", () => {
    const html = renderToString(
      h(Dashboard, { app: makeCtx({ hasCatalog: true, loading: false, booted: true }) }),
    );
    expect(html).toContain("All clear");
    expect(html).not.toContain("cd-skel-bar");
  });

  it("a FAILED boot keeps the honest loading state — never a fake All clear or All quiet", () => {
    // loading flipped off but booted never did: some boot endpoint failed.
    const html = renderToString(
      h(Dashboard, { app: makeCtx({ hasCatalog: true, loading: false, booted: false }) }),
    );
    expect(html).not.toContain("All clear");
    expect(html).not.toContain("All quiet");
    expect(html).not.toContain("standing by");
    expect(html).toContain("cd-skel-bar");
    expect(html).toContain("<b>—</b>");
  });

  it("an established store's prompt bar is a real text input that submits to the assistant", () => {
    const html = renderToString(h(Dashboard, { app: makeCtx({ hasCatalog: true, loading: true }) }));
    expect(html).toContain("cd-promptbar-in");
    expect(html).toContain('placeholder="Tell Calderyn what to do…"');
    expect(html).toContain("cd-promptbar-send");
  });

  it("a fresh store's prompt bar stays a button into the product flow (typed text has nowhere to go)", () => {
    const html = renderToString(h(Dashboard, { app: makeCtx({ hasCatalog: false, loading: true }) }));
    expect(html).toContain("Describe your first product…");
    expect(html).not.toContain("cd-promptbar-in");
  });
});
