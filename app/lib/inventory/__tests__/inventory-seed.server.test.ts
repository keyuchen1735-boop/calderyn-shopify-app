import { describe, it, expect, vi, beforeEach } from "vitest";

// Stateful, chain-shaped Supabase stub so we can assert exactly which writes the
// seeding logic performs (location create, ledger adjust) under each precondition.
const h = vi.hoisted(() => ({
  state: { locations: [] as { id: string }[], balances: [] as { variant_id: string }[] },
  rpc: vi.fn(),
  insertLocation: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    rpc: h.rpc,
    from: (table: string) => {
      if (table === "location_dim") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: h.state.locations, error: null }),
                }),
              }),
            }),
          }),
          insert: (row: unknown) => {
            h.insertLocation(row);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: "loc-created" }, error: null }) }) };
          },
        };
      }
      if (table === "inventory_balance") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: h.state.balances, error: null }) }) }) }),
          }),
        };
      }
      return {};
    },
  }),
}));
vi.mock("../project-level-fact.server", () => ({ projectLevelFact: vi.fn().mockResolvedValue(undefined) }));

beforeEach(() => {
  h.state.locations = [];
  h.state.balances = [];
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: null, error: null });
  h.insertLocation.mockReset();
});

describe("seedInitialStock", () => {
  it("does nothing when the quantity is zero or negative", async () => {
    const { seedInitialStock } = await import("../engine.server");
    await seedInitialStock("shop1", "v1", 0);
    await seedInitialStock("shop1", "v1", -3);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.insertLocation).not.toHaveBeenCalled();
  });

  it("creates a Primary location and posts the initial on-hand when the variant has no balance yet", async () => {
    h.state.locations = [];
    h.state.balances = [];
    const { seedInitialStock } = await import("../engine.server");
    await seedInitialStock("shop1", "v1", 20);
    expect(h.insertLocation).toHaveBeenCalledWith(expect.objectContaining({ shop_id: "shop1", name: "Primary", priority: 0 }));
    expect(h.rpc).toHaveBeenCalledWith(
      "inventory_adjust",
      expect.objectContaining({ p_shop_id: "shop1", p_variant_id: "v1", p_location_id: "loc-created", p_new_on_hand: 20 }),
    );
  });

  it("does not overwrite an existing balance row (idempotent re-save)", async () => {
    h.state.locations = [{ id: "loc-1" }];
    h.state.balances = [{ variant_id: "v1" }];
    const { seedInitialStock } = await import("../engine.server");
    await seedInitialStock("shop1", "v1", 50);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.insertLocation).not.toHaveBeenCalled();
  });
});

describe("ensurePrimaryLocation", () => {
  it("reuses the shop's existing location without inserting a new one", async () => {
    h.state.locations = [{ id: "loc-existing" }];
    const { ensurePrimaryLocation } = await import("../engine.server");
    expect(await ensurePrimaryLocation("shop1")).toBe("loc-existing");
    expect(h.insertLocation).not.toHaveBeenCalled();
  });

  it("creates a Primary location when the shop has none", async () => {
    h.state.locations = [];
    const { ensurePrimaryLocation } = await import("../engine.server");
    expect(await ensurePrimaryLocation("shop1")).toBe("loc-created");
    expect(h.insertLocation).toHaveBeenCalledWith(expect.objectContaining({ name: "Primary", priority: 0, active: true }));
  });
});
