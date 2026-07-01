import { describe, it, expect, vi, beforeEach } from "vitest";
import { CalderynError } from "~/lib/calderyn.server";

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1" }),
}));

// drift.server transitively imports shopify.server (module-scope app init), so it is
// fully replaced; the route goes through the REAL dashboardJson envelope so the
// CalderynError -> status/code mapping is what production runs.
const checkDualRunDrift = vi.fn();
vi.mock("~/lib/cutover/drift.server", () => ({
  checkDualRunDrift: (shopId: string) => checkDualRunDrift(shopId),
}));

const REPORT = {
  variantsChecked: 3,
  pass: false,
  price: { count: 1, rows: [{ variantId: "v1", label: "Tee (S1)", owned: 1000, shopify: 1200 }] },
  stock: { count: 0, rows: [] },
  shopifyOnly: { count: 0, sample: [] },
  ownedOnly: { count: 0, sample: [] },
  truncated: { count: 0, sample: [] },
  unmatchedLocations: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  checkDualRunDrift.mockResolvedValue(REPORT);
});

describe("cutover-drift route", () => {
  it("GET returns the drift report for the signed-in shop", async () => {
    const { loader } = await import("../dashboard.api.cutover-drift");
    const res = (await loader({ request: new Request("https://app.x/x") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(checkDualRunDrift).toHaveBeenCalledWith("shop1");
  });

  it("maps shopify_unreachable to 502 with the plain-language message", async () => {
    checkDualRunDrift.mockRejectedValue(
      new CalderynError({
        code: "shopify_unreachable",
        status: 502,
        message: "Could not reach Shopify to compare values. Try again in a moment.",
      }),
    );
    const { loader } = await import("../dashboard.api.cutover-drift");
    const res = (await loader({ request: new Request("https://app.x/x") } as never)) as Response;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "shopify_unreachable",
      message: "Could not reach Shopify to compare values. Try again in a moment.",
    });
  });

  it("maps not_connected to 409 for a shop without a Shopify side", async () => {
    checkDualRunDrift.mockRejectedValue(
      new CalderynError({
        code: "not_connected",
        status: 409,
        message: "This store is not connected to Shopify, so there is nothing to compare.",
      }),
    );
    const { loader } = await import("../dashboard.api.cutover-drift");
    const res = (await loader({ request: new Request("https://app.x/x") } as never)) as Response;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_connected");
  });

  it("answers 500 on a system failure without leaking the raw error", async () => {
    checkDualRunDrift.mockRejectedValue(new Error("db connection lost"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { loader } = await import("../dashboard.api.cutover-drift");
      const res = (await loader({ request: new Request("https://app.x/x") } as never)) as Response;
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal_error" });
    } finally {
      consoleError.mockRestore();
    }
  });
});
