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

  it("throws on a non-200 response (caller skips the shop, never fabricates)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(
      fetchRegionForecasts([{ region: "us-west", lat: 1, lon: 1 }]),
    ).rejects.toThrow();
  });
});

describe("per-day forecasts", () => {
  it("exposes each forecast day (date + numbers) alongside the window aggregate", async () => {
    const loc = fakeLocation([12, 20, 30], [8, 10, 20], [9, 0, 3], [1.5, 0, 0], [36000, 36000, 36000]);
    (loc.daily as Record<string, unknown>).time = ["2026-07-07", "2026-07-08", "2026-07-09"];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([loc]), { status: 200 })));

    const out = await fetchRegionForecasts([{ region: "us-west", lat: 1, lon: 1 }]);
    expect(out.get("us-west")!.days).toEqual([
      { date: "2026-07-07", avgTempC: 10, precipMm: 9, snowCm: 1.5 },
      { date: "2026-07-08", avgTempC: 15, precipMm: 0, snowCm: 0 },
      { date: "2026-07-09", avgTempC: 25, precipMm: 3, snowCm: 0 },
    ]);
  });
});
