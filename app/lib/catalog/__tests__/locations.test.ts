import { describe, it, expect, vi, beforeEach } from "vitest";

const eqInner = vi.fn().mockResolvedValue({ error: null });
const eqOuter = vi.fn(() => ({ eq: eqInner }));
const update = vi.fn(() => ({ eq: eqOuter }));
const sb = { from: () => ({ update }) } as never;

beforeEach(() => {
  eqInner.mockClear();
  eqOuter.mockClear();
  update.mockClear();
  eqInner.mockResolvedValue({ error: null });
});

describe("updateLocationDetails", () => {
  it("updates location_dim filtered by shop_id and id with exactly the passed patch", async () => {
    const { updateLocationDetails } = await import("../locations.server");
    await updateLocationDetails(sb, "shop1", "loc1", { priority: 2, lat: 43.6, lng: -79.4 });
    expect(update).toHaveBeenCalledWith({ priority: 2, lat: 43.6, lng: -79.4 });
    expect(eqOuter).toHaveBeenCalledWith("shop_id", "shop1");
    expect(eqInner).toHaveBeenCalledWith("id", "loc1");
  });

  it("throws when supabase returns an error", async () => {
    eqInner.mockResolvedValue({ error: { message: "boom" } });
    const { updateLocationDetails } = await import("../locations.server");
    await expect(updateLocationDetails(sb, "shop1", "loc1", { city: "Toronto" })).rejects.toBeTruthy();
  });
});
