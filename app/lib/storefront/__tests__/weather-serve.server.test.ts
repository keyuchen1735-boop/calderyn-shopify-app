import { describe, it, expect, vi, beforeEach } from "vitest";

const getSeoSettings = vi.fn();
const maybeSingle = vi.fn();

vi.mock("~/lib/seo/seo-store.server", () => ({
  getSeoSettings: (...a: unknown[]) => getSeoSettings(...a),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { visitorRegion, storefrontWeatherCondition } from "../weather-serve.server";

const req = (headers: Record<string, string>): Request =>
  new Request("https://shop.example.com/storefront", { headers });

// New York City → the us-east centroid, so a US visitor there resolves to us-east.
const US_EAST = {
  "x-vercel-ip-country": "US",
  "x-vercel-ip-latitude": "40.71",
  "x-vercel-ip-longitude": "-74.01",
};

describe("visitorRegion", () => {
  it("maps a US visitor's edge coordinates to a region", () => {
    expect(visitorRegion(req(US_EAST))).toBe("us-east");
  });
  it("returns null for a non-US visitor", () => {
    expect(
      visitorRegion(req({ "x-vercel-ip-country": "CA", "x-vercel-ip-latitude": "43.6", "x-vercel-ip-longitude": "-79.4" })),
    ).toBeNull();
  });
  it("returns null when coordinates are missing", () => {
    expect(visitorRegion(req({ "x-vercel-ip-country": "US" }))).toBeNull();
  });
});

describe("storefrontWeatherCondition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is neutral (no lookup) when the shop's toggle is off", async () => {
    getSeoSettings.mockResolvedValue({ weatherMerchandising: false });
    expect(await storefrontWeatherCondition(req(US_EAST), "shop-1")).toBe("neutral");
    expect(maybeSingle).not.toHaveBeenCalled();
  });
  it("is neutral for a non-US visitor even when on", async () => {
    getSeoSettings.mockResolvedValue({ weatherMerchandising: true });
    expect(await storefrontWeatherCondition(req({ "x-vercel-ip-country": "GB" }), "shop-1")).toBe("neutral");
    expect(maybeSingle).not.toHaveBeenCalled();
  });
  it("returns the VISITOR region's stored condition when on", async () => {
    getSeoSettings.mockResolvedValue({ weatherMerchandising: true });
    maybeSingle.mockResolvedValue({ data: { condition: "storm" }, error: null });
    expect(await storefrontWeatherCondition(req(US_EAST), "shop-1")).toBe("storm");
  });
  it("is neutral when there is no cached forecast for the region", async () => {
    getSeoSettings.mockResolvedValue({ weatherMerchandising: true });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await storefrontWeatherCondition(req(US_EAST), "shop-1")).toBe("neutral");
  });
  it("fails safe to neutral on any error (public buyer path)", async () => {
    getSeoSettings.mockRejectedValue(new Error("db down"));
    expect(await storefrontWeatherCondition(req(US_EAST), "shop-1")).toBe("neutral");
  });
});
