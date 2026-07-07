import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Seed the screen cache so the SSR render paints the overview (effects don't run
// server-side); mock the data layer so no network is touched.
const overview = {
  storeHealth: 90, productCount: 2, needsAttention: [], aiCrawls: [], aiCrawlTotal: 0,
  settings: { allowAiCrawlers: true, orgName: null, orgDescription: null },
  google: { connected: false, clicks: 0, impressions: 0, topQuery: null, topPosition: null },
};
let seeded = overview;
vi.mock("~/lib/dashboard/screen-cache", () => ({
  cachedScreenData: () => seeded,
  cacheScreenData: () => {},
  SCREEN_CACHE_KEYS: { search: "search" },
}));
vi.mock("~/lib/dashboard/search-client", () => ({
  fetchSearch: async () => seeded,
  loadProductDetail: async () => ({}),
  saveOverride: async () => ({ ok: true }),
  resetOverride: async () => ({ ok: true }),
  updateSettings: async () => ({ settings: seeded.settings }),
  connectGoogleSearchConsole: async () => ({ url: "https://accounts.google.com/x" }),
  disconnectGoogleSearchConsole: async () => ({ ok: true }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import Search from "../Search";
// eslint-disable-next-line import/first -- see above
import type { DashboardCtx } from "../../context";

function makeApp(): DashboardCtx {
  return { toast: () => {}, refresh: () => {} } as unknown as DashboardCtx;
}

beforeEach(() => { seeded = overview; });

describe("Search 'On Google' card", () => {
  it("shows a Connect Google button when not connected", () => {
    const html = renderToStaticMarkup(h(Search, { app: makeApp() }));
    expect(html).toContain("Connect Google");
    expect(html).not.toContain("Disconnect");
  });
  it("shows Connected + Disconnect when connected", () => {
    seeded = { ...overview, google: { ...overview.google, connected: true } };
    const html = renderToStaticMarkup(h(Search, { app: makeApp() }));
    expect(html).toContain("Disconnect");
  });
});
