import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// No real network: renderToStaticMarkup does not run effects, but mock anyway so
// an accidental call is inert.
vi.mock("~/lib/dashboard/search-client", () => ({
  fetchSearchSettings: vi.fn().mockResolvedValue(null),
  updateSettings: vi.fn(),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import Search, { loadSearchSettings, saveAllowAiCrawlers } from "../screens/Search";
// eslint-disable-next-line import/first
import { cacheScreenData, clearScreenCache, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
// eslint-disable-next-line import/first
import { parsePath, pathFor } from "../routes";
// eslint-disable-next-line import/first
import type { DashboardCtx } from "../context";
// eslint-disable-next-line import/first
import { fetchSearchSettings, updateSettings } from "~/lib/dashboard/search-client";
// eslint-disable-next-line import/first
import type { SeoSettings } from "~/lib/dashboard/search-client";

const app = { toast: () => {}, navigate: () => {} } as unknown as DashboardCtx;
const settings: SeoSettings = { allowAiCrawlers: true, orgName: null, orgDescription: null };

beforeEach(() => {
  clearScreenCache();
  vi.clearAllMocks();
});

describe("Search screen (smoke)", () => {
  it("renders the auto-optimized status and the AI-access toggle without crashing", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, settings);
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("Search");
    expect(html).toContain("How your store looks to Google and AI assistants.");
    expect(html).toContain("Your store is optimized, automatically.");
    expect(html).toContain(
      "Every product page is written for Google and AI assistants the moment you publish it. There is nothing to set up.",
    );
    expect(html).toContain("Let AI assistants read and cite my store");
    expect(html).toContain('role="switch"');
  });

  it("shows the skeleton before any data is cached", () => {
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("cd-skel");
  });

  it("seeds the optional description field from settings.orgDescription", () => {
    cacheScreenData(SCREEN_CACHE_KEYS.search, {
      ...settings,
      orgDescription: "Hand-poured candles for home.",
    });
    const html = renderToStaticMarkup(<Search app={app} />);
    expect(html).toContain("How your store is described to Google (optional)");
    expect(html).toContain('value="Hand-poured candles for home."');
  });
});

describe("Search settings load/retry", () => {
  it("flags a friendly load error when the fetch fails, and clears it on a successful retry", async () => {
    const data: SeoSettings[] = [];
    const errors: boolean[] = [];
    const setData = (state: SeoSettings) => data.push(state);
    const setLoadError = (failed: boolean) => errors.push(failed);

    vi.mocked(fetchSearchSettings).mockRejectedValueOnce(new Error("network down"));
    await loadSearchSettings(setData, setLoadError);
    expect(errors).toEqual([true]);
    expect(data).toEqual([]);

    // The Retry button re-calls the exact same function; a successful retry
    // must clear the error and deliver the fresh settings.
    vi.mocked(fetchSearchSettings).mockResolvedValueOnce(settings);
    await loadSearchSettings(setData, setLoadError);
    expect(errors).toEqual([true, false]);
    expect(data).toEqual([settings]);
  });

  it("invokes onError on a failed background refresh, but not on success", async () => {
    let onErrorCalls = 0;
    const onError = () => {
      onErrorCalls++;
    };

    vi.mocked(fetchSearchSettings).mockRejectedValueOnce(new Error("network down"));
    await loadSearchSettings(() => {}, () => {}, onError);
    expect(onErrorCalls).toBe(1); // a stale-data refresh failure surfaces to the caller

    vi.mocked(fetchSearchSettings).mockResolvedValueOnce(settings);
    await loadSearchSettings(() => {}, () => {}, onError);
    expect(onErrorCalls).toBe(1); // not called again on a successful refresh
  });
});

describe("Search AI-access toggle", () => {
  it("toggling calls updateSettings with the new allowAiCrawlers flag and reports success", async () => {
    vi.mocked(updateSettings).mockResolvedValueOnce({
      settings: { ...settings, allowAiCrawlers: false },
    });
    let saved = 0;
    await saveAllowAiCrawlers(
      false,
      () => {
        saved++;
      },
      () => {},
    );
    expect(updateSettings).toHaveBeenCalledWith({ allowAiCrawlers: false });
    expect(saved).toBe(1);
  });

  it("reports an error instead of saved when the request fails", async () => {
    vi.mocked(updateSettings).mockRejectedValueOnce(new Error("network down"));
    let errored = 0;
    await saveAllowAiCrawlers(
      true,
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
