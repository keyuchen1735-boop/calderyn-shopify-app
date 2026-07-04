import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loader, ORGANIC_SWEEP_UTC_HOUR } from "../cron.calibration-recompute";

// Mock the recompute + organic sweep + supabase so the route is tested in isolation.
vi.mock("../../lib/calibration/recompute.server", () => ({
  recomputeShopCalibration: vi.fn(async (id: string) => ({ shopId: id, pairs: 1, raw: 25, display: 25 })),
  loadPeerPriors: vi.fn(async () => new Map<string, number>()),
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
  // The organic sweep is a nightly batch: it only runs on the
  // ORGANIC_SWEEP_UTC_HOUR tick. Pin the clock there by default so the sweep
  // assertions exercise the nightly run; the hourly-skip test overrides.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(2026, 6, 3, ORGANIC_SWEEP_UTC_HOUR, 45, 0)));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cron.calibration-recompute loader", () => {
  it("401s without the bearer secret", async () => {
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("sweeps organic signals then recomputes each shop with the correct secret", async () => {
    const { sweepOrganicSignals } = await import("../../lib/calibration/organic.server");
    const { recomputeShopCalibration, loadPeerPriors } = await import(
      "../../lib/calibration/recompute.server"
    );
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.shops).toBe(1);
    expect(vi.mocked(sweepOrganicSignals)).toHaveBeenCalledWith("shop-1", expect.anything());
    // Peer priors are shop-independent: fetched ONCE for the whole run and
    // shared with every shop's recompute (the per-shop N+1 fix).
    expect(vi.mocked(loadPeerPriors)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recomputeShopCalibration)).toHaveBeenCalledWith(
      "shop-1",
      expect.anything(),
      expect.objectContaining({ peerPriors: expect.any(Map) }),
    );
  });

  it("skips the organic sweep on non-nightly hourly runs (bulk-pause suppression needs one batch)", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 3, (ORGANIC_SWEEP_UTC_HOUR + 3) % 24, 45, 0)));
    const { sweepOrganicSignals } = await import("../../lib/calibration/organic.server");
    const { recomputeShopCalibration } = await import("../../lib/calibration/recompute.server");
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shops).toBe(1); // recompute still runs hourly
    expect(vi.mocked(recomputeShopCalibration)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sweepOrganicSignals)).not.toHaveBeenCalled();
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

  it("surfaces organic sweep soft-errors without failing the run (best-effort, non-fatal)", async () => {
    const { sweepOrganicSignals } = await import("../../lib/calibration/organic.server");
    vi.mocked(sweepOrganicSignals).mockResolvedValueOnce({
      implicitApprovals: 1,
      reversals: 0,
      errors: ["implicit al-1: campaign read failed"],
    });
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    // A best-effort organic read hiccup must NOT flip the whole cron to 500
    // (that would trip failed-cron alerting + a full-run retry). Surfaced, not fatal.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.shops).toBe(1); // the recompute still ran for the shop
    expect(body.implicitApprovals).toBe(1);
    expect(body.errors).toEqual([]); // hard-error channel stays clean
    expect(body.organicErrors[0]).toContain("organic"); // soft-error channel carries it
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
