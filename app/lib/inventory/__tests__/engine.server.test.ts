import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const project = vi.fn().mockResolvedValue(undefined);
const balanceRows = [{ location_id: "to", priority: 0, lat: null, lng: null }, { location_id: "van", priority: 1, lat: null, lng: null }];
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    rpc,
    from: (t: string) => {
      // locationOrder filters shop_id AND active, so select chains two .eq calls.
      if (t === "location_dim") return { select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: balanceRows.map((b) => ({ id: b.location_id, priority: b.priority, lat: b.lat, lng: b.lng })), error: null }) }) }) };
      return { upsert: vi.fn().mockResolvedValue({ error: null }) };
    },
  }),
}));
vi.mock("../project-level-fact.server", () => ({ projectLevelFact: project }));

beforeEach(() => { rpc.mockReset(); project.mockClear(); });

describe("reserveStock", () => {
  it("returns the allocation on success and passes the ordered location ids to the RPC", async () => {
    rpc.mockResolvedValue({ data: { ok: true, allocation: [{ locationId: "to", qty: 2 }] }, error: null });
    const { reserveStock } = await import("../engine.server");
    const r = await reserveStock("shop1", "v1", 2, "co1");
    expect(r).toEqual({ ok: true, allocation: [{ locationId: "to", qty: 2 }] });
    // The atomic reserve must receive the allocator-ordered location list, not an arbitrary order.
    expect(rpc).toHaveBeenCalledWith("inventory_reserve", expect.objectContaining({ p_location_ids: ["to", "van"], p_variant_id: "v1", p_qty: 2 }));
  });

  it("maps the insufficient_stock exception to ok:false", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "insufficient_stock" } });
    const { reserveStock } = await import("../engine.server");
    expect(await reserveStock("shop1", "v1", 99, "co2")).toEqual({ ok: false, reason: "insufficient_stock" });
  });
});

describe("merchant mutations route through atomic SQL functions", () => {
  it("adjustStock calls inventory_adjust with a clamped (non-negative) count", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const { adjustStock } = await import("../engine.server");
    await adjustStock("shop1", "v1", "l1", -5, "recount");
    expect(rpc).toHaveBeenCalledWith("inventory_adjust", expect.objectContaining({ p_shop_id: "shop1", p_variant_id: "v1", p_location_id: "l1", p_new_on_hand: 0, p_reason: "recount" }));
    expect(project).toHaveBeenCalledWith("shop1", "v1", "l1");
  });

  it("markUnavailable surfaces the clamp rejection as insufficient_available", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "insufficient_available" } });
    const { markUnavailable } = await import("../engine.server");
    await expect(markUnavailable("shop1", "v1", "l1", 999, "damaged")).rejects.toThrow("insufficient_available");
    expect(project).not.toHaveBeenCalled();
  });

  it("createTransfer returns the transfer id and projects both endpoints on an instant move", async () => {
    rpc.mockResolvedValue({ data: "transfer-123", error: null });
    const { createTransfer } = await import("../engine.server");
    const res = await createTransfer("shop1", "v1", "from1", "to1", 3, "instant");
    expect(res).toEqual({ transferId: "transfer-123" });
    expect(project).toHaveBeenCalledWith("shop1", "v1", "from1");
    expect(project).toHaveBeenCalledWith("shop1", "v1", "to1");
  });
});
