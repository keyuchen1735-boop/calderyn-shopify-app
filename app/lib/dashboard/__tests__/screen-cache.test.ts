import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheScreenData,
  cachedScreenData,
  catalogCacheKey,
  clearScreenCache,
  prefetchScreenData,
} from "../screen-cache";

beforeEach(() => {
  clearScreenCache();
});

describe("cachedScreenData / cacheScreenData", () => {
  it("returns null on a cold key", () => {
    expect(cachedScreenData("orders")).toBeNull();
  });

  it("round-trips a stored value", () => {
    const page = { orders: [{ id: "o1" }], total: 1 };
    cacheScreenData("orders", page);
    expect(cachedScreenData("orders")).toBe(page);
  });

  it("keeps keys independent", () => {
    cacheScreenData("orders", "a");
    cacheScreenData("customers", "b");
    expect(cachedScreenData("orders")).toBe("a");
    expect(cachedScreenData("customers")).toBe("b");
  });

  it("overwrites on re-set (last write wins)", () => {
    cacheScreenData("orders", "old");
    cacheScreenData("orders", "new");
    expect(cachedScreenData("orders")).toBe("new");
  });

  it("stores falsy-but-real values (empty list) distinctly from a miss", () => {
    cacheScreenData("collections", []);
    expect(cachedScreenData("collections")).toEqual([]);
  });
});

describe("prefetchScreenData", () => {
  it("fetches and caches on a cold key", async () => {
    let calls = 0;
    await prefetchScreenData("orders", async () => {
      calls++;
      return "page";
    });
    expect(calls).toBe(1);
    expect(cachedScreenData("orders")).toBe("page");
  });

  it("does not fetch when the key is already cached", async () => {
    cacheScreenData("orders", "warm");
    let calls = 0;
    await prefetchScreenData("orders", async () => {
      calls++;
      return "cold";
    });
    expect(calls).toBe(0);
    expect(cachedScreenData("orders")).toBe("warm");
  });

  it("dedupes concurrent prefetches of the same key", async () => {
    let calls = 0;
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const fetcher = () => {
      calls++;
      return gate;
    };
    const a = prefetchScreenData("orders", fetcher);
    const b = prefetchScreenData("orders", fetcher);
    release("page");
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(cachedScreenData("orders")).toBe("page");
  });

  it("swallows fetch failures and leaves the key cold so a later attempt retries", async () => {
    await expect(
      prefetchScreenData("orders", async () => {
        throw new Error("boom");
      }),
    ).resolves.toBeUndefined();
    expect(cachedScreenData("orders")).toBeNull();
    // A retry after the failure fetches again (in-flight marker was cleared).
    await prefetchScreenData("orders", async () => "recovered");
    expect(cachedScreenData("orders")).toBe("recovered");
  });

  it("does not clobber a fresher direct write with a slower prefetch", async () => {
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const p = prefetchScreenData("orders", () => gate);
    // A real screen fetch lands while the prefetch is still in flight.
    cacheScreenData("orders", "fresh");
    release("stale");
    await p;
    expect(cachedScreenData("orders")).toBe("fresh");
  });
});

describe("catalogCacheKey", () => {
  it("keys the default filter deterministically", () => {
    expect(catalogCacheKey("", undefined)).toBe(catalogCacheKey("", undefined));
  });

  it("separates different filters", () => {
    expect(catalogCacheKey("", undefined)).not.toBe(catalogCacheKey("mug", undefined));
    expect(catalogCacheKey("", undefined)).not.toBe(catalogCacheKey("", "draft"));
  });
});
