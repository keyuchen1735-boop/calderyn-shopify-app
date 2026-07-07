import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// No real network: renderToStaticMarkup does not run effects, but mock anyway so
// an accidental call is inert.
vi.mock("~/lib/dashboard/search-client", () => ({
  fetchSearch: vi.fn().mockResolvedValue(null),
  loadProductDetail: vi.fn(),
  saveOverride: vi.fn(),
  resetOverride: vi.fn(),
  updateSettings: vi.fn(),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import Search from "../screens/Search";
// eslint-disable-next-line import/first
import { cacheScreenData, clearScreenCache, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
// eslint-disable-next-line import/first
import { parsePath, pathFor } from "../routes";
// eslint-disable-next-line import/first
import type { DashboardCtx } from "../context";

const app = { toast: () => {}, navigate: () => {} } as unknown as DashboardCtx;
const overview = {
  storeHealth: 82,
  productCount: 3,
  needsAttention: [
    { id: "p1", handle: "cedar", title: "Cedar Bloom", score: 71, topIssue: "Meta description", hasOverride: false },
  ],
  aiCrawls: [
    { botName: "GPTBot", hits: 1200 },
    { botName: "PerplexityBot", hits: 40 },
  ],
  aiCrawlTotal: 1240,
  settings: { allowAiCrawlers: true, allowAiTraining: false, orgName: null, orgDescription: null },
};

beforeEach(() => clearScreenCache());

describe("Search screen (smoke)", () => {
  it("renders the seeded overview without crashing", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, overview);
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("Search");
    expect(html).toContain("82"); // store health
    expect(html).toContain("Cedar Bloom"); // needs-attention row
    expect(html).toContain("Meta description"); // plain top issue
    expect(html).toContain("Fix it"); // row action
    expect(html).toContain("ChatGPT"); // friendly assistant name for GPTBot
    expect(html).toContain("1,240"); // AI-visit total
  });

  it("shows the skeleton before any data is cached", () => {
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("cd-skel");
  });

  it("shows the empty-catalog copy at zero products", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, { ...overview, productCount: 0, needsAttention: [] });
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("automatically optimized for search and AI");
  });
});

describe("search route registration", () => {
  it("seg and parsePath are exact inverses for the search screen", () => {
    expect(pathFor({ screen: "search", param: null, sub: null })).toBe("/dashboard/search");
    expect(parsePath("/dashboard/search")).toEqual({ screen: "search", param: null, sub: null });
  });

  it("exposes a stable cache key", () => {
    expect(SCREEN_CACHE_KEYS.search).toBe("search");
  });
});
