import { describe, it, expect, vi, beforeEach } from "vitest";
// Subject under test. Hoisted to the top to satisfy import/first; Vitest hoists
// the vi.mock calls below above all imports, so the mocks still apply.
import { loader } from "../cron.weather-merch";

const { isAuthorizedCron, fetchRegionForecasts, upsert } = vi.hoisted(() => ({
  isAuthorizedCron: vi.fn<(auth: string | null, secret: string | undefined) => boolean>(),
  fetchRegionForecasts: vi.fn<(points: unknown) => Promise<Map<string, unknown>>>(),
  upsert: vi.fn(async (_rows: Record<string, unknown>[], _opts: { onConflict: string }) => ({
    error: null as { message: string } | null,
  })),
}));

vi.mock("~/lib/cron-auth.server", () => ({ isAuthorizedCron }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ upsert }) }),
}));
vi.mock("~/lib/weather/open-meteo.server", () => ({ fetchRegionForecasts }));

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://x/cron/weather-merch", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockImplementation(async () => ({ error: null }));
});

describe("cron.weather-merch loader", () => {
  it("rejects an unauthorized request without calling the forecast fetch", async () => {
    isAuthorizedCron.mockReturnValue(false);
    const res = await loader({ request: req("Bearer wrong") } as never);
    expect(res.status).toBe(401);
    expect(fetchRegionForecasts).not.toHaveBeenCalled();
  });

  it("upserts a condition row per region derived from the forecast", async () => {
    isAuthorizedCron.mockReturnValue(true);
    fetchRegionForecasts.mockResolvedValue(
      new Map([
        ["us-west", { avgTempC: 26, precipMm: 0, snowCm: 0, avgDaylightH: 14 }],
        ["us-east", { avgTempC: 0, precipMm: 30, snowCm: 10, avgDaylightH: 8 }],
      ]),
    );

    const res = await loader({ request: req("Bearer s3cret") } as never);
    expect(res.status).toBe(200);

    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: "region" });
    expect(rows).toContainEqual(expect.objectContaining({ region: "us-west", condition: "sun" }));
    expect(rows).toContainEqual(expect.objectContaining({ region: "us-east", condition: "storm" }));
  });

  it("returns 502 and skips the upsert when the forecast fetch rejects", async () => {
    isAuthorizedCron.mockReturnValue(true);
    fetchRegionForecasts.mockRejectedValue(new Error("open-meteo 500"));

    const res = await loader({ request: req("Bearer s3cret") } as never);
    expect(res.status).toBe(502);
    expect(upsert).not.toHaveBeenCalled();
  });
});
