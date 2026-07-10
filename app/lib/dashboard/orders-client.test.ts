import { describe, it, expect, vi, beforeEach } from "vitest";

// The orders list's page size (50) can select more orders than the server-side bulk routes will
// accept in one request (MAX_BULK_ORDERS = 25, app/lib/order/bulk.server.ts) — a select-all-on-
// page bulk action used to 422 the whole request. These tests pin the client-side chunking fix:
// slices of <=25, sent sequentially, results concatenated back into one flat array.
const store = vi.hoisted(() => ({ apiSend: vi.fn() }));

vi.mock("./client", () => ({
  apiSend: store.apiSend,
  apiGet: vi.fn(),
  DashboardApiError: class DashboardApiError extends Error {},
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the fake client is registered first
import { bulkFulfillOrders, bulkArchiveOrders, bulkAddOrderTags, chunk } from "./orders-client";

function ids(n: number, prefix = "o"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

beforeEach(() => {
  store.apiSend.mockReset();
});

describe("chunk", () => {
  it("splits an array into slices of at most `size`", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single slice when the array is already within size", () => {
    expect(chunk([1, 2], 25)).toEqual([[1, 2]]);
  });

  it("returns an empty array for an empty input", () => {
    expect(chunk([], 25)).toEqual([]);
  });

  it("returns exactly one full slice when the array length equals size", () => {
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });
});

describe("bulk order actions chunk selections over the server's 25-order cap", () => {
  it("bulkFulfillOrders splits 60 ids into 25/25/10 requests and concatenates the results", async () => {
    const calls: string[][] = [];
    store.apiSend.mockImplementation(async (_method: string, _path: string, body: { order_ids: string[] }) => {
      calls.push([...body.order_ids]);
      return { results: body.order_ids.map((id) => ({ order_id: id, ok: true })) };
    });

    const orderIds = ids(60);
    const { results } = await bulkFulfillOrders(orderIds, true, "key-1");

    expect(calls.map((c) => c.length)).toEqual([25, 25, 10]);
    expect(results).toHaveLength(60);
    expect(results.map((r) => r.orderId)).toEqual(orderIds);
  });

  it("issues chunk requests sequentially, not in parallel", async () => {
    const order: string[] = [];
    store.apiSend.mockImplementation(async (_method: string, _path: string, body: { order_ids: string[] }) => {
      order.push(`start:${body.order_ids[0]}`);
      await new Promise((r) => setTimeout(r, 0));
      order.push(`end:${body.order_ids[0]}`);
      return { results: [] };
    });

    await bulkFulfillOrders(ids(50), false, "key");

    // If the two chunks ran in parallel, both "start" entries would land before either "end".
    expect(order).toEqual(["start:o0", "end:o0", "start:o25", "end:o25"]);
  });

  it("does not chunk a selection at or under the cap", async () => {
    store.apiSend.mockResolvedValue({ results: [] });
    await bulkFulfillOrders(ids(25), true, "key");
    expect(store.apiSend).toHaveBeenCalledTimes(1);
  });

  it("bulkArchiveOrders chunks a 30-order selection into two requests", async () => {
    store.apiSend.mockResolvedValue({ results: [] });
    await bulkArchiveOrders(ids(30), true);
    expect(store.apiSend).toHaveBeenCalledTimes(2);
  });

  it("bulkAddOrderTags chunks a 26-order selection into two requests", async () => {
    store.apiSend.mockResolvedValue({ results: [] });
    await bulkAddOrderTags(ids(26), ["rush"]);
    expect(store.apiSend).toHaveBeenCalledTimes(2);
  });

  it("a rejected middle chunk never discards earlier chunks' already-succeeded results", async () => {
    let call = 0;
    store.apiSend.mockImplementation(async (_method: string, _path: string, body: { order_ids: string[] }) => {
      call += 1;
      if (call === 2) throw new Error("network blip");
      return { results: body.order_ids.map((id) => ({ order_id: id, ok: true })) };
    });

    // 3 chunks of 25/25/10; the 2nd (ids o25-o49) throws outright.
    const { results } = await bulkFulfillOrders(ids(60), false, "key");

    expect(results).toHaveLength(60);
    expect(results.filter((r) => r.ok)).toHaveLength(35); // chunk 1 (25) + chunk 3 (10)
    const failed = results.filter((r) => !r.ok);
    expect(failed).toHaveLength(25); // chunk 2, downgraded to per-order failures
    expect(failed.every((r) => r.error === "Something went wrong.")).toBe(true);
  });
});
