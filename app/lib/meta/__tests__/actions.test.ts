import { describe, it, expect, vi } from "vitest";
import { makeMetaActionAdapter } from "../actions.server";
import { isRetriableFailure } from "../../ads/actions";
import { RateLimitError } from "../../ads/backoff";
import type { MetaClient } from "../campaigns.server";

function client(getBody: Record<string, unknown>): MetaClient {
  return {
    get: vi.fn(async () => getBody),
    post: vi.fn(async () => ({ success: true })),
  };
}

describe("metaActionAdapter", () => {
  it("pause posts status PAUSED", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).pause("c1");
    expect(c.post).toHaveBeenCalledWith("/c1", { status: "PAUSED" });
  });

  it("resume posts status ACTIVE", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).resume("c1");
    expect(c.post).toHaveBeenCalledWith("/c1", { status: "ACTIVE" });
  });

  it("setDailyBudget posts daily_budget in minor units as a string", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).setDailyBudget("c1", 5000);
    expect(c.post).toHaveBeenCalledWith("/c1", { daily_budget: "5000" });
  });

  it("getState maps effective_status + daily_budget", async () => {
    const c = client({ status: "PAUSED", daily_budget: "5000" });
    const s = await makeMetaActionAdapter(c).getState("c1");
    expect(s).toEqual({ status: "paused", dailyBudgetCents: 5000 });
  });
});

describe("metaActionAdapter rate limiting", () => {
  const THROTTLED = { error: { message: "There have been too many calls to this ad-account.", code: 80004 } };
  const NO_SLEEP = { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} };

  it("retries a throttled setDailyBudget with backoff and succeeds", async () => {
    let calls = 0;
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => (++calls === 1 ? THROTTLED : { success: true })),
    };
    await makeMetaActionAdapter(c, NO_SLEEP).setDailyBudget("c1", 700);
    expect(c.post).toHaveBeenCalledTimes(2);
  });

  it("a still-throttled call exhausts the cap and stays classified retriable for the executor", async () => {
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => THROTTLED),
    };
    const err = await makeMetaActionAdapter(c, NO_SLEEP)
      .setDailyBudget("c1", 700)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(isRetriableFailure(err)).toBe(true);
    expect(c.post).toHaveBeenCalledTimes(NO_SLEEP.maxAttempts);
  });

  it("non-throttle errors fail fast without retrying", async () => {
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => ({ error: { message: "Invalid parameter", code: 100 } })),
    };
    await expect(makeMetaActionAdapter(c, NO_SLEEP).setDailyBudget("c1", 700)).rejects.toThrow(
      /Invalid parameter/,
    );
    expect(c.post).toHaveBeenCalledTimes(1);
  });

  it("pause retries a throttled status post through setCampaignStatus", async () => {
    let calls = 0;
    const c: MetaClient = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => (++calls === 1 ? THROTTLED : { success: true })),
    };
    await makeMetaActionAdapter(c, NO_SLEEP).pause("c1");
    expect(c.post).toHaveBeenCalledTimes(2);
    expect(c.post).toHaveBeenLastCalledWith("/c1", { status: "PAUSED" });
  });

  it("getState retries a throttled read", async () => {
    let calls = 0;
    const c: MetaClient = {
      get: vi.fn(async () => (++calls === 1 ? THROTTLED : { status: "PAUSED", daily_budget: "500" })),
      post: vi.fn(async () => ({ success: true })),
    };
    const s = await makeMetaActionAdapter(c, NO_SLEEP).getState("c1");
    expect(s).toEqual({ status: "paused", dailyBudgetCents: 500 });
    expect(c.get).toHaveBeenCalledTimes(2);
  });
});
