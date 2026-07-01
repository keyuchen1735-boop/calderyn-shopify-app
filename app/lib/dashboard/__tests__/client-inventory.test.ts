import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.stubGlobal("location", { origin: "https://app.x", assign: vi.fn() } as unknown as Location);
const ok = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) } as Response);
beforeEach(() => fetchMock.mockReset());

describe("inventory client", () => {
  it("setOnHand PUTs the set_on_hand intent to the variant endpoint", async () => {
    fetchMock.mockReturnValue(ok({ ok: true }));
    const { setOnHand } = await import("../client");
    await setOnHand("v1", "l1", 9);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/dashboard/api/catalog/inventory/v1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ intent: "set_on_hand", locationId: "l1", onHand: 9 });
  });

  it("fetchVariantInventory GETs and unwraps balances", async () => {
    fetchMock.mockReturnValue(ok({ balances: [{ locationId: "l1", onHand: 3 }] }));
    const { fetchVariantInventory } = await import("../client");
    const rows = await fetchVariantInventory("v1");
    expect(fetchMock.mock.calls[0][0]).toBe("/dashboard/api/catalog/inventory/v1");
    expect(rows).toEqual([{ locationId: "l1", onHand: 3 }]);
  });

  it("createTransfer POSTs the transfer body", async () => {
    fetchMock.mockReturnValue(ok({ transferId: "t1" }));
    const { createTransfer } = await import("../client");
    const res = await createTransfer({ variantId: "v1", fromLocationId: "a", toLocationId: "b", qty: 2, mode: "instant" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/dashboard/api/catalog/inventory/transfer");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ variantId: "v1", fromLocationId: "a", toLocationId: "b", qty: 2, mode: "instant" });
    expect(res).toEqual({ transferId: "t1" });
  });

  it("fetchLocations GETs and unwraps locations", async () => {
    fetchMock.mockReturnValue(ok({ locations: [{ id: "l1", name: "Main", priority: 0, lat: null, lng: null }] }));
    const { fetchLocations } = await import("../client");
    expect(await fetchLocations()).toEqual([{ id: "l1", name: "Main", priority: 0, lat: null, lng: null }]);
  });
});
