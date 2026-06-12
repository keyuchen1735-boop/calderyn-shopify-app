import { describe, it, expect, vi, beforeEach } from "vitest";
import { throttleMetaClient, __resetMetaThrottleForTests } from "../throttle.server";
import { RateLimitError } from "../../ads/backoff";
import type { MetaClient } from "../campaigns.server";

function innerClient(): MetaClient {
  return {
    get: vi.fn(async () => ({ ok: true })),
    post: vi.fn(async () => ({ success: true })),
  };
}

describe("throttleMetaClient", () => {
  beforeEach(() => __resetMetaThrottleForTests());

  it("passes calls through to the wrapped client", async () => {
    const inner = innerClient();
    const c = throttleMetaClient(inner, "shop-1", { maxCallsPerHour: 10, minIntervalMs: 0 });
    await c.get("/x", { fields: "status" });
    await c.post("/x", { status: "PAUSED" });
    expect(inner.get).toHaveBeenCalledWith("/x", { fields: "status" });
    expect(inner.post).toHaveBeenCalledWith("/x", { status: "PAUSED" });
  });

  it("spaces consecutive calls by the minimum interval", async () => {
    const inner = innerClient();
    const sleeps: number[] = [];
    let t = 0;
    const c = throttleMetaClient(inner, "shop-1", {
      maxCallsPerHour: 10,
      minIntervalMs: 200,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await c.get("/a");
    await c.get("/b"); // immediately after — must wait out the interval
    expect(sleeps).toEqual([200]);
  });

  it("self-throttles above the hourly budget WITHOUT calling Meta", async () => {
    const inner = innerClient();
    const c = throttleMetaClient(inner, "shop-1", { maxCallsPerHour: 2, minIntervalMs: 0 });
    await c.get("/a");
    await c.get("/b");
    await expect(c.get("/c")).rejects.toThrow(RateLimitError);
    expect(inner.get).toHaveBeenCalledTimes(2);
  });

  it("replenishes the budget when the window rolls over", async () => {
    const inner = innerClient();
    let t = 0;
    const c = throttleMetaClient(inner, "shop-1", {
      maxCallsPerHour: 1,
      minIntervalMs: 0,
      now: () => t,
      sleep: async () => {},
    });
    await c.get("/a");
    await expect(c.get("/b")).rejects.toThrow(RateLimitError);
    t += 3_600_001; // window elapsed
    await c.get("/c");
    expect(inner.get).toHaveBeenCalledTimes(2);
  });

  it("tracks budgets per key, not globally", async () => {
    const inner = innerClient();
    const a = throttleMetaClient(inner, "shop-a", { maxCallsPerHour: 1, minIntervalMs: 0 });
    const b = throttleMetaClient(inner, "shop-b", { maxCallsPerHour: 1, minIntervalMs: 0 });
    await a.get("/a");
    await expect(a.get("/a2")).rejects.toThrow(RateLimitError);
    await b.get("/b"); // a separate shop's budget is untouched
    expect(inner.get).toHaveBeenCalledTimes(2);
  });
});
