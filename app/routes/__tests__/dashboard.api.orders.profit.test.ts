// Route test for the profit read model (Phase 4 Task 3): GET-only, mirrors
// dashboard.api.orders.detail.test.ts's convention (session.server mocked, orderProfit mocked so
// this test only asserts the route's shape/wiring, not profit.server.ts's own math — that's
// profit.server.test.ts's job).
import { describe, it, expect, vi, beforeEach } from "vitest";

const SESSION = {
  shopId: "shop-1",
  shopDomain: null,
  userId: "u1",
  sessionId: "s1",
  emailVerified: true,
  onboardedAt: null,
  accountCreatedAt: null,
};

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue(SESSION),
}));

const orderProfit = vi.fn();
vi.mock("~/lib/order/profit.server", () => ({
  orderProfit: (...a: unknown[]) => orderProfit(...a),
}));

const ORIGIN = "https://calderyncompany.com";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /dashboard/api/orders/:id/profit", () => {
  it("404s an unknown order id", async () => {
    orderProfit.mockResolvedValue(null);
    const { loader } = await import("../dashboard.api.orders.$id.profit");
    await expect(
      loader({ request: new Request(`${ORIGIN}/dashboard/api/orders/nope/profit`), params: { id: "nope" } } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(orderProfit).toHaveBeenCalledWith("shop-1", "nope");
  });

  it("returns the profit DTO snake_cased on a known id", async () => {
    orderProfit.mockResolvedValue({
      source: "calderyn",
      revenueCents: 10000,
      cogsCents: 5000,
      costsMissing: 0,
      carrierCostCents: 500,
      feeEstimateCents: 320,
      profitCents: 4180,
      marginPct: 41.8,
      estimated: true,
      attributionLabel: "meta",
    });
    const { loader } = await import("../dashboard.api.orders.$id.profit");
    const res = (await loader({
      request: new Request(`${ORIGIN}/dashboard/api/orders/order-1/profit`),
      params: { id: "order-1" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      profit: {
        source: "calderyn",
        revenue_cents: 10000,
        cogs_cents: 5000,
        costs_missing: 0,
        carrier_cost_cents: 500,
        fee_estimate_cents: 320,
        profit_cents: 4180,
        margin_pct: 41.8,
        estimated: true,
        attribution_label: "meta",
      },
    });
  });

  it("passes a shopify:-prefixed id straight through to orderProfit (its own prefix parsing)", async () => {
    orderProfit.mockResolvedValue({
      source: "shopify",
      revenueCents: 4000,
      cogsCents: 1000,
      costsMissing: 0,
      carrierCostCents: null,
      feeEstimateCents: 146,
      profitCents: 2854,
      marginPct: 71.35,
      estimated: true,
      attributionLabel: null,
    });
    const { loader } = await import("../dashboard.api.orders.$id.profit");
    const res = (await loader({
      request: new Request(`${ORIGIN}/dashboard/api/orders/shopify:imp-1/profit`),
      params: { id: "shopify:imp-1" },
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(orderProfit).toHaveBeenCalledWith("shop-1", "shopify:imp-1");
    const json = (await res.json()) as { profit: { carrier_cost_cents: number | null; attribution_label: string | null } };
    expect(json.profit.carrier_cost_cents).toBeNull();
    expect(json.profit.attribution_label).toBeNull();
  });
});
