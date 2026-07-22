import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi
    .fn()
    .mockResolvedValue({ shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1" }),
}));
vi.mock("~/lib/dashboard/http.server", () => ({
  dashboardJson: async (fn: () => Promise<unknown>) =>
    new Response(JSON.stringify(await fn()), { status: 200 }),
}));

const listInventory = vi.fn().mockResolvedValue({ rows: [], total: 0 });
const attachRestockPresence = vi.fn(async (_shopId: string, rows: unknown[]) => rows);
vi.mock("~/lib/catalog/inventory-list.server", () => ({ listInventory, attachRestockPresence }));

beforeEach(() => {
  listInventory.mockClear();
});

const get = async (qs: string) => {
  const { loader } = await import("../dashboard.api.catalog.inventory._index");
  return (await loader({ request: new Request(`https://app.x/x${qs}`) } as never)) as Response;
};

/** The options the loader handed to listInventory on its last call. */
const lastOpts = () => listInventory.mock.calls.at(-1)?.[1] as Record<string, unknown>;

describe("inventory list route sorting", () => {
  it("passes a known sort column and direction through to the query", async () => {
    const res = await get("?sort=on_hand&dir=asc");
    expect(res.status).toBe(200);
    expect(lastOpts()).toMatchObject({ sort: "on_hand", dir: "asc" });
  });

  it("leaves the sort unset when no column is requested", async () => {
    // Unset means the RPC's own lowest-stock-first ordering, which is the
    // screen's default view.
    await get("");
    expect(lastOpts().sort).toBeUndefined();
  });

  it("drops an unknown sort column instead of forwarding it", async () => {
    await get("?sort=onhand&dir=desc");
    expect(lastOpts().sort).toBeUndefined();

    await get("?sort=on_hand%3B%20drop%20table%20variant_dim&dir=desc");
    expect(lastOpts().sort).toBeUndefined();
  });

  it("falls back to descending on a missing or unrecognized direction", async () => {
    await get("?sort=available");
    expect(lastOpts()).toMatchObject({ sort: "available", dir: "desc" });

    await get("?sort=available&dir=sideways");
    expect(lastOpts()).toMatchObject({ sort: "available", dir: "desc" });
  });

  it("keeps sorting shop-scoped to the session, never the query string", async () => {
    await get("?sort=product&dir=asc&shopId=someone-else");
    expect(listInventory.mock.calls.at(-1)?.[0]).toBe("shop1");
  });

  it("still applies search, stock and offset alongside a sort", async () => {
    await get("?search=hoodie&stock=low&offset=50&sort=product&dir=asc");
    expect(lastOpts()).toMatchObject({
      search: "hoodie",
      stock: "low",
      offset: 50,
      sort: "product",
      dir: "asc",
    });
  });
});
