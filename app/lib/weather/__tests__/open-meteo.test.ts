import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRegionForecasts } from "../open-meteo.server";

function fakeLocation(tmax: number[], tmin: number[], precip: number[], snow: number[], daylightSec: number[]) {
  return {
    daily: {
      temperature_2m_max: tmax,
      temperature_2m_min: tmin,
      precipitation_sum: precip,
      snowfall_sum: snow,
      daylight_duration: daylightSec,
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchRegionForecasts", () => {
  it("parses the batched array into per-region aggregates", async () => {
    const body = [
      fakeLocation([12, 12, 12], [8, 8, 8], [2, 2, 2], [0, 0, 0], [36000, 36000, 36000]),
      fakeLocation([0, 0, 0], [-4, -4, -4], [1, 1, 1], [3, 3, 3], [32400, 32400, 32400]),
      fakeLocation([20, 20, 20], [10, 10, 10], [0, 0, 0], [0, 0, 0], [43200, 43200, 43200]),
      fakeLocation([5, 5, 5], [-1, -1, -1], [4, 4, 4], [1, 1, 1], [34200, 34200, 34200]),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const out = await fetchRegionForecasts([
      { region: "us-west", lat: 1, lon: 1 },
      { region: "us-central", lat: 2, lon: 2 },
      { region: "us-south", lat: 3, lon: 3 },
      { region: "us-east", lat: 4, lon: 4 },
    ]);

    expect(out.get("us-west")).toEqual({ avgTempC: 10, precipMm: 6, snowCm: 0, avgDaylightH: 10 });
    expect(out.get("us-central")!.avgTempC).toBeCloseTo(-2, 6);
    expect(out.get("us-central")!.snowCm).toBe(9);
  });

  it("skips a location whose 200 response omits the daily series (never fabricates a 0 forecast)", async () => {
    const body = [
      { daily: {} }, // present but empty — must NOT become a 0°C / 0-daylight forecast
      fakeLocation([5, 5, 5], [-1, -1, -1], [4, 4, 4], [1, 1, 1], [34200, 34200, 34200]),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const out = await fetchRegionForecasts([
      { region: "us-west", lat: 1, lon: 1 },
      { region: "us-east", lat: 2, lon: 2 },
    ]);

    expect(out.has("us-west")).toBe(false);
    expect(out.get("us-east")!.avgTempC).toBeCloseTo(2, 6);
  });

  it("throws on a non-200 response (caller skips the shop, never fabricates)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(
      fetchRegionForecasts([{ region: "us-west", lat: 1, lon: 1 }]),
    ).rejects.toThrow();
  });
});
