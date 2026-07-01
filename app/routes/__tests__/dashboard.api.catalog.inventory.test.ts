import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1" }),
}));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  jsonOk: (b: unknown) => new Response(JSON.stringify(b), { status: 200 }),
  jsonError: (s: number, e: string, m?: string) => new Response(JSON.stringify(m ? { error: e, message: m } : { error: e }), { status: s }),
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
}));
const adjustStock = vi.fn().mockResolvedValue(undefined);
const markUnavailable = vi.fn().mockResolvedValue(undefined);
const createTransfer = vi.fn().mockResolvedValue({ transferId: "t1" });
const receiveTransfer = vi.fn().mockResolvedValue(undefined);
const setReorderPoint = vi.fn().mockResolvedValue(undefined);
const getVariantBalances = vi.fn().mockResolvedValue([{ locationId: "l1", onHand: 5 }]);
vi.mock("~/lib/inventory/engine.server", () => ({ adjustStock, markUnavailable, createTransfer, receiveTransfer, setReorderPoint, getVariantBalances }));

// Chainable supabase builder for the transfer loader (lists in-transit transfers).
function builder(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {
    select: () => b, eq: () => b, order: () => b, in: () => b,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return b;
}
const transfersResult = { data: [{ id: "t1", variant_id: "v1", qty: 2, from_location_id: "a", to_location_id: "b", created_at: "now" }], error: null };
const locsResult = { data: [{ id: "a", name: "A" }, { id: "b", name: "B" }], error: null };
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => (t === "inventory_transfer" ? builder(transfersResult) : builder(locsResult)) }),
}));

beforeEach(() => { adjustStock.mockClear(); markUnavailable.mockReset().mockResolvedValue(undefined); createTransfer.mockClear(); getVariantBalances.mockClear(); });

const putReq = (body: unknown) => new Request("https://app.x/x", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const postReq = (body: unknown) => new Request("https://app.x/x", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("inventory variant route", () => {
  it("GET returns per-location balances, shop-scoped", async () => {
    const { loader } = await import("../dashboard.api.catalog.inventory.$variantId");
    const res = (await loader({ request: new Request("https://app.x/x"), params: { variantId: "v1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(getVariantBalances).toHaveBeenCalledWith("shop1", "v1");
  });

  it("PUT set_on_hand calls adjustStock with the session shopId", async () => {
    const { action } = await import("../dashboard.api.catalog.inventory.$variantId");
    const res = (await action({ request: putReq({ intent: "set_on_hand", locationId: "l1", onHand: 12 }), params: { variantId: "v1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(adjustStock).toHaveBeenCalledWith("shop1", "v1", "l1", 12, undefined);
  });

  it("PUT mark_unavailable maps the engine clamp rejection to a 422", async () => {
    markUnavailable.mockRejectedValueOnce(new Error("insufficient_available"));
    const { action } = await import("../dashboard.api.catalog.inventory.$variantId");
    const res = (await action({ request: putReq({ intent: "mark_unavailable", locationId: "l1", qty: 999 }), params: { variantId: "v1" } } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("insufficient_available");
  });

  it("PUT rejects an unknown intent", async () => {
    const { action } = await import("../dashboard.api.catalog.inventory.$variantId");
    const res = (await action({ request: putReq({ intent: "nope", locationId: "l1" }), params: { variantId: "v1" } } as never)) as Response;
    expect(res.status).toBe(422);
  });
});

describe("inventory transfer route", () => {
  it("POST create calls createTransfer; POST receive calls receiveTransfer", async () => {
    const { action } = await import("../dashboard.api.catalog.inventory.transfer");
    const res = (await action({ request: postReq({ variantId: "v1", fromLocationId: "a", toLocationId: "b", qty: 2, mode: "instant" }) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(createTransfer).toHaveBeenCalledWith("shop1", "v1", "a", "b", 2, "instant");

    const res2 = (await action({ request: postReq({ intent: "receive", transferId: "t9" }) } as never)) as Response;
    expect(res2.status).toBe(200);
    expect(receiveTransfer).toHaveBeenCalledWith("shop1", "t9");
  });

  it("POST rejects a same-location transfer", async () => {
    const { action } = await import("../dashboard.api.catalog.inventory.transfer");
    const res = (await action({ request: postReq({ variantId: "v1", fromLocationId: "a", toLocationId: "a", qty: 2 }) } as never)) as Response;
    expect(res.status).toBe(422);
  });

  it("GET lists pending in-transit transfers with resolved location names", async () => {
    const { loader } = await import("../dashboard.api.catalog.inventory.transfer");
    const res = (await loader({ request: new Request("https://app.x/x?variantId=v1") } as never)) as Response;
    expect(res.status).toBe(200);
    expect((await res.json()).transfers).toEqual([
      { id: "t1", variantId: "v1", qty: 2, fromName: "A", toName: "B", createdAt: "now" },
    ]);
  });
});
