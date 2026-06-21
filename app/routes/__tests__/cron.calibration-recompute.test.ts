import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the recompute + supabase so the route is tested in isolation.
vi.mock("../../lib/calibration/recompute.server", () => ({
  recomputeShopCalibration: vi.fn(async (id: string) => ({ shopId: id, pairs: 1, raw: 25, display: 25 })),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => Promise.resolve({ data: [{ id: "shop-1" }], error: null }) }),
  }),
}));

import { loader } from "../cron.calibration-recompute";

const req = (auth?: string) =>
  new Request("https://app.test/cron/calibration-recompute", {
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
});

describe("cron.calibration-recompute loader", () => {
  it("401s without the bearer secret", async () => {
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });
  it("recomputes each shop with the correct secret", async () => {
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.shops).toBe(1);
  });
});
