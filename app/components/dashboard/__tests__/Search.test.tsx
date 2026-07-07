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
  connectGoogleSearchConsole: vi.fn(),
  disconnectGoogleSearchConsole: vi.fn(),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import Search, { loadSearchOverview, loadSearchProductDetail, ProductLoadError } from "../screens/Search";
// eslint-disable-next-line import/first
import { cacheScreenData, clearScreenCache, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
// eslint-disable-next-line import/first
import { parsePath, pathFor } from "../routes";
// eslint-disable-next-line import/first
import type { DashboardCtx } from "../context";
// eslint-disable-next-line import/first
import { fetchSearch, loadProductDetail } from "~/lib/dashboard/search-client";
// eslint-disable-next-line import/first
import type { ProductSeoDetailVM, SeoOverviewVM } from "~/lib/dashboard/search-client";

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
  google: { connected: false, clicks: 0, impressions: 0, topQuery: null, topPosition: null },
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

  it("keeps Settings reachable even with zero products", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, { ...overview, productCount: 0, needsAttention: [] });
    const html = renderToStaticMarkup(<Search app={app} />);
    // The empty-catalog placeholder still shows...
    expect(html).toContain("automatically optimized for search and AI");
    // ...and a brand-new merchant can still reach the AI-crawler toggle and
    // store description fields without adding a product first.
    expect(html).toContain("Let AI assistants read and cite my store");
    expect(html).toContain("Store name");
    expect(html).toContain("One-line description");
  });

  it("shows the current store name and description in Settings", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, {
      ...overview,
      settings: { ...overview.settings, orgName: "Cedar Bloom Co", orgDescription: "Hand-poured candles for home." },
    });
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain('value="Cedar Bloom Co"');
    expect(html).toContain('value="Hand-poured candles for home."');
  });
});

describe("Search overview load/retry", () => {
  it("flags a friendly load error when the fetch fails, and clears it on a successful retry", async () => {
    const data: SeoOverviewVM[] = [];
    const errors: boolean[] = [];
    const setData = (state: SeoOverviewVM) => data.push(state);
    const setLoadError = (failed: boolean) => errors.push(failed);

    vi.mocked(fetchSearch).mockRejectedValueOnce(new Error("network down"));
    await loadSearchOverview(setData, setLoadError);
    expect(errors).toEqual([true]);
    expect(data).toEqual([]);

    // The Retry button re-calls the exact same function; a successful retry
    // must clear the error and deliver the fresh overview.
    vi.mocked(fetchSearch).mockResolvedValueOnce(overview);
    await loadSearchOverview(setData, setLoadError);
    expect(errors).toEqual([true, false]);
    expect(data).toEqual([overview]);
  });
});

describe("Search product editor load/retry", () => {
  const productDetail: ProductSeoDetailVM = {
    id: "p1",
    handle: "cedar",
    title: "Cedar Bloom",
    googlePreview: {
      title: "Cedar Bloom",
      url: "https://example.com/products/cedar",
      description: "A cedar bloom candle.",
    },
    health: { score: 71, checks: [] },
    override: null,
    aiSummary: "",
  };

  it("reports a load error when the detail fetch fails, and loads on a successful retry", async () => {
    const loaded: ProductSeoDetailVM[] = [];
    let errored = 0;

    vi.mocked(loadProductDetail).mockRejectedValueOnce(new Error("network down"));
    await loadSearchProductDetail(
      "cedar",
      (d) => loaded.push(d),
      () => errored++,
    );
    expect(errored).toBe(1);
    expect(loaded).toEqual([]);

    // The Try again button re-calls the exact same function.
    vi.mocked(loadProductDetail).mockResolvedValueOnce(productDetail);
    await loadSearchProductDetail(
      "cedar",
      (d) => loaded.push(d),
      () => errored++,
    );
    expect(errored).toBe(1);
    expect(loaded).toEqual([productDetail]);
  });

  it("renders a calm message with Back and Try again controls", () => {
    const html = renderToStaticMarkup(<ProductLoadError onBack={() => {}} onRetry={() => {}} />);
    // JSX text content HTML-escapes the apostrophe.
    expect(html).toContain("We couldn&#x27;t load this page.");
    expect(html).toContain("Back");
    expect(html).toContain("Try again");
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
