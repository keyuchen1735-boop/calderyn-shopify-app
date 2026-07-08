import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// No real network: renderToStaticMarkup does not run effects, but mock anyway so
// an accidental call is inert.
vi.mock("~/lib/dashboard/search-client", () => ({
  fetchSearchOverview: vi.fn().mockResolvedValue(null),
  updateSettings: vi.fn(),
  suggestDescription: vi.fn(),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import Search, { loadSearchOverview, saveSetting, weatherStatusLine } from "../screens/Search";
// eslint-disable-next-line import/first
import { cacheScreenData, clearScreenCache, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
// eslint-disable-next-line import/first
import { parsePath, pathFor } from "../routes";
// eslint-disable-next-line import/first
import type { DashboardCtx } from "../context";
// eslint-disable-next-line import/first
import { fetchSearchOverview, updateSettings } from "~/lib/dashboard/search-client";
// eslint-disable-next-line import/first
import type { SeoSettings, SearchOverviewVM } from "~/lib/dashboard/search-client";

const app = { toast: () => {}, navigate: () => {} } as unknown as DashboardCtx;
const settings: SeoSettings = { allowSearchEngines: true, allowAiCrawlers: true, weatherMerchandising: true, orgName: null, orgDescription: null, googleSiteVerification: null };
const overview: SearchOverviewVM = { settings, sitemapUrl: "https://demo.calderyncompany.com/sitemap.xml", weatherStatus: null };

beforeEach(() => {
  clearScreenCache();
  vi.clearAllMocks();
});

describe("Search screen (smoke)", () => {
  it("renders the Preferences header and both access toggles without crashing", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, overview);
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("Preferences");
    // The two plain enable-rows a merchant controls.
    expect(html).toContain("Search engines (SEO)");
    expect(html).toContain("AI assistants (AIO)");
    expect(html).toContain("Weather-aware ordering");
    // Three switches (search + AI + weather); the description field has none.
    expect(html.match(/role="switch"/g)?.length).toBe(3);
  });

  it("shows the skeleton before any data is cached", () => {
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("cd-skel");
  });

  it("offers a Calderyn 'write it for me' control beside the store description", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, overview);
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("Store description");
    // Sparkle affordance + its tooltip copy naming Google + AI.
    expect(html).toContain("Let Calderyn write");
    expect(html).toContain("Google and AI assistants");
  });

  it("renders the Get-found-on-Google helper with the live sitemap URL and a verify field", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, overview);
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("Get found on Google");
    // Step 2 shows the site address to register (root, no /sitemap.xml).
    expect(html).toContain("https://demo.calderyncompany.com<"); // site URL chip
    expect(html).toContain("URL prefix");
    expect(html).toContain("HTML tag");
    expect(html).toContain("Paste code here");
    expect(html).toContain("Open Google");
    // Step 5 gives the RELATIVE path (Google pre-fills the domain) + a deep link
    // into this property's Sitemaps page in Search Console.
    expect(html).toContain(">sitemap.xml<");
    expect(html).toContain("search-console/sitemaps?resource_id=");
  });

  it("shows the verified confirmation once a code is saved", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, {
      ...overview,
      settings: { ...settings, googleSiteVerification: "google-xyz" },
    });
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("Saved and live");
  });

  it("seeds the optional store-description field from settings.orgDescription", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, {
      ...overview,
      settings: { ...settings, orgDescription: "Hand-poured candles for home." },
    });
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("Store description");
    expect(html).toContain('value="Hand-poured candles for home."');
  });
});

describe("Search overview load/retry", () => {
  it("flags a friendly load error when the fetch fails, and clears it on a successful retry", async () => {
    const data: SearchOverviewVM[] = [];
    const errors: boolean[] = [];
    const setData = (state: SearchOverviewVM) => data.push(state);
    const setLoadError = (failed: boolean) => errors.push(failed);

    vi.mocked(fetchSearchOverview).mockRejectedValueOnce(new Error("network down"));
    await loadSearchOverview(setData, setLoadError);
    expect(errors).toEqual([true]);
    expect(data).toEqual([]);

    // The Retry button re-calls the exact same function; a successful retry
    // must clear the error and deliver the fresh payload.
    vi.mocked(fetchSearchOverview).mockResolvedValueOnce(overview);
    await loadSearchOverview(setData, setLoadError);
    expect(errors).toEqual([true, false]);
    expect(data).toEqual([overview]);
  });

  it("invokes onError on a failed background refresh, but not on success", async () => {
    let onErrorCalls = 0;
    const onError = () => {
      onErrorCalls++;
    };

    vi.mocked(fetchSearchOverview).mockRejectedValueOnce(new Error("network down"));
    await loadSearchOverview(() => {}, () => {}, onError);
    expect(onErrorCalls).toBe(1); // a stale-data refresh failure surfaces to the caller

    vi.mocked(fetchSearchOverview).mockResolvedValueOnce(overview);
    await loadSearchOverview(() => {}, () => {}, onError);
    expect(onErrorCalls).toBe(1); // not called again on a successful refresh
  });
});

describe("Search access toggles", () => {
  it("saves the AI-access flag and reports success", async () => {
    vi.mocked(updateSettings).mockResolvedValueOnce({
      settings: { ...settings, allowAiCrawlers: false },
    });
    let saved = 0;
    await saveSetting(
      { allowAiCrawlers: false },
      () => {
        saved++;
      },
      () => {},
    );
    expect(updateSettings).toHaveBeenCalledWith({ allowAiCrawlers: false });
    expect(saved).toBe(1);
  });

  it("saves the search-engine flag and reports success", async () => {
    vi.mocked(updateSettings).mockResolvedValueOnce({
      settings: { ...settings, allowSearchEngines: false },
    });
    let saved = 0;
    await saveSetting(
      { allowSearchEngines: false },
      () => {
        saved++;
      },
      () => {},
    );
    expect(updateSettings).toHaveBeenCalledWith({ allowSearchEngines: false });
    expect(saved).toBe(1);
  });

  it("reports an error instead of saved when the request fails", async () => {
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error("network down"));
    let errored = 0;
    await saveSetting(
      { allowAiCrawlers: true },
      () => {},
      () => {
        errored++;
      },
    );
    expect(errored).toBe(1);
  });
});

describe("search route registration", () => {
  it("seg and parsePath are exact inverses for the search screen (nested under Store > Preferences)", () => {
    expect(pathFor({ screen: "search", param: null, sub: null })).toBe(
      "/dashboard/store/preferences",
    );
    expect(parsePath("/dashboard/store/preferences")).toEqual({
      screen: "search",
      param: null,
      sub: null,
    });
  });

  it("retires the old top-level /dashboard/search path", () => {
    // Search moved under Store; the legacy segment no longer resolves and
    // canonicalizes to Mission Control.
    expect(parsePath("/dashboard/search")).toBeNull();
  });

  it("exposes a stable cache key", () => {
    expect(SCREEN_CACHE_KEYS.search).toBe("search");
  });
});

describe("Search access toggles — weather-aware ordering", () => {
  it("saves the weather flag and reports success", async () => {
    vi.mocked(updateSettings).mockResolvedValueOnce({
      settings: { ...settings, weatherMerchandising: false },
    });
    let saved = 0;
    await saveSetting({ weatherMerchandising: false }, () => { saved++; }, () => {});
    expect(updateSettings).toHaveBeenCalledWith({ weatherMerchandising: false });
    expect(saved).toBe(1);
  });
});

describe("weatherStatusLine", () => {
  it("prompts to set a location when the status is unresolved", () => {
    expect(weatherStatusLine(null, true)).toContain("Set a store location");
  });
  it("shows the forecast but not the boost when the toggle is off", () => {
    const line = weatherStatusLine({ region: "us-east", condition: "storm" }, false);
    expect(line).toContain("cold & wet");
    expect(line).toContain("Turn on");
  });
  it("describes the active boost per condition when on", () => {
    expect(weatherStatusLine({ region: "us-east", condition: "storm" }, true)).toContain("rain");
    expect(weatherStatusLine({ region: "us-west", condition: "sun" }, true)).toContain("warm-weather");
    expect(weatherStatusLine({ region: "us-central", condition: "neutral" }, true)).toContain("no weather change");
  });
});
