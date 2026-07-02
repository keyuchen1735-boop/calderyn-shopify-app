import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.calibration-recompute";

// Mock the recompute + organic sweep + supabase so the route is tested in isolation.
vi.mock("../../lib/calibration/recompute.server", () => ({
  recomputeShopCalibration: vi.fn(async (id: string) => ({ shopId: id, pairs: 1, raw: 25, display: 25 })),
}));
vi.mock("../../lib/calibration/organic.server", () => ({
  sweepOrganicSignals: vi.fn(async () => ({ implicitApprovals: 0, reversals: 0, errors: [] })),
}));

const shopRows: Array<Record<string, unknown>> = [{ id: "shop-1", demo_mode: false }];
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => Promise.resolve({ data: shopRows, error: null }) }),
  }),
}));

const req = (auth?: string) =>
  new Request("https://app.test/cron/calibration-recompute", {
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  shopRows.length = 0;
  shopRows.push({ id: "shop-1", demo_mode: false });
});

describe("cron.calibration-recompute loader", () => {
  it("401s without the bearer secret", async () => {
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("sweeps organic signals then recomputes each shop with the correct secret", async () => {
    const { sweepOrganicSignals } = await import("../../lib/calibration/organic.server");
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.shops).toBe(1);
    expect(vi.mocked(sweepOrganicSignals)).toHaveBeenCalledWith("shop-1", expect.anything());
  });

  it("skips the organic sweep for demo shops (seeded state would misfire the matchers)", async () => {
    shopRows.length = 0;
    shopRows.push({ id: "shop-demo", demo_mode: true });
    const { sweepOrganicSignals } = await import("../../lib/calibration/organic.server");
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shops).toBe(1); // recompute still runs
    expect(vi.mocked(sweepOrganicSignals)).not.toHaveBeenCalled();
  });

  it("surfaces organic sweep errors without blocking the recompute", async () => {
    const { sweepOrganicSignals } = await import("../../lib/calibration/organic.server");
    vi.mocked(sweepOrganicSignals).mockResolvedValueOnce({
      implicitApprovals: 1,
      reversals: 0,
      errors: ["implicit al-1: campaign read failed"],
    });
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(500); // partial: visible, not swallowed (rule 12)
    const body = await res.json();
    expect(body.shops).toBe(1); // the recompute still ran for the shop
    expect(body.implicitApprovals).toBe(1);
    expect(body.errors[0]).toContain("organic");
  });

  it("500s when a shop recompute throws", async () => {
    const { recomputeShopCalibration } = await import("../../lib/calibration/recompute.server");
    vi.mocked(recomputeShopCalibration).mockRejectedValueOnce(new Error("boom"));
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
