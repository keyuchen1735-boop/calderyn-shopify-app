import { describe, it, expect, vi, beforeEach } from "vitest";

const isAuthorizedCron = vi.fn();
const upsert = vi.fn();
const fetchRegionForecasts = vi.fn();

vi.mock("~/lib/cron-auth.server", () => ({
  isAuthorizedCron: (...a: unknown[]) => isAuthorizedCron(...a),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ upsert }) }),
}));
vi.mock("~/lib/weather/open-meteo.server", () => ({
  fetchRegionForecasts: (...a: unknown[]) => fetchRegionForecasts(...a),
}));

import { loader } from "../cron.weather-merch";

const req = () =>
  new Request("https://calderyncompany.com/cron/weather-merch", {
    headers: { authorization: "Bearer secret" },
  });

describe("cron.weather-merch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s without cron auth", async () => {
    isAuthorizedCron.mockReturnValue(false);
    const res = (await loader({ request: req() } as never)) as Response;
    expect(res.status).toBe(401);
    expect(fetchRegionForecasts).not.toHaveBeenCalled();
  });

  it("upserts a weather condition row per region", async () => {
    isAuthorizedCron.mockReturnValue(true);
    upsert.mockResolvedValue({ error: null });
    fetchRegionForecasts.mockResolvedValue(
      new Map([
        ["us-west", { avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 }], // sun
        ["us-east", { avgTempC: 0, precipMm: 30, snowCm: 10, avgDaylightH: 8 }], // storm
      ]),
    );
    const res = (await loader({ request: req() } as never)) as Response;
    const body = (await res.json()) as { updated: number };
    expect(body.updated).toBe(2);
    expect(upsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ region: "us-west", condition: "sun" }),
        expect.objectContaining({ region: "us-east", condition: "storm" }),
      ]),
      { onConflict: "region" },
    );
  });

  it("502s on a forecast failure and does not upsert (fail-closed)", async () => {
    isAuthorizedCron.mockReturnValue(true);
    fetchRegionForecasts.mockRejectedValue(new Error("open-meteo down"));
    const res = (await loader({ request: req() } as never)) as Response;
    expect(res.status).toBe(502);
    expect(upsert).not.toHaveBeenCalled();
  });
});
