import { describe, it, expect, vi } from "vitest";

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1" }) }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
}));
const order = vi.fn().mockResolvedValue({ data: [{ id: "l1", name: "Main", priority: 0, lat: null, lng: null }], error: null });
const update = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }));
vi.mock("~/lib/supabase.server", () => ({
  // GET filters shop_id AND active, so select chains two .eq calls before .order.
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order }) }) }), update }) }),
}));

describe("locations route", () => {
  it("GET lists the shop's locations ordered by priority", async () => {
    const { loader } = await import("../dashboard.api.catalog.locations._index");
    const res = (await loader({ request: new Request("https://app.x/x") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ locations: [{ id: "l1", name: "Main", priority: 0, lat: null, lng: null }] });
  });

  it("PUT updates priority + coordinates", async () => {
    const { action } = await import("../dashboard.api.catalog.locations.$id");
    const req = new Request("https://app.x/x", { method: "PUT", body: JSON.stringify({ priority: 2, lat: 43.6, lng: -79.4 }), headers: { "Content-Type": "application/json" } });
    const res = (await action({ request: req, params: { id: "l1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ priority: 2, lat: 43.6, lng: -79.4 }));
  });

  it("PUT clears coordinates when passed null", async () => {
    const { action } = await import("../dashboard.api.catalog.locations.$id");
    const req = new Request("https://app.x/x", { method: "PUT", body: JSON.stringify({ lat: null, lng: null }), headers: { "Content-Type": "application/json" } });
    const res = (await action({ request: req, params: { id: "l1" } } as never)) as Response;
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ lat: null, lng: null }));
  });

  it("PUT rejects an empty patch", async () => {
    const { action } = await import("../dashboard.api.catalog.locations.$id");
    const req = new Request("https://app.x/x", { method: "PUT", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } });
    const res = (await action({ request: req, params: { id: "l1" } } as never)) as Response;
    expect(res.status).toBe(422);
  });
});
