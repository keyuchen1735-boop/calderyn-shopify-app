import { describe, it, expect, vi } from "vitest";
import { withRetry, RateLimitError } from "../backoff";

describe("withRetry", () => {
  it("returns the result when the fn succeeds first try", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on RateLimitError then succeeds", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (n++ < 2) throw new RateLimitError("429");
      return "ok";
    });
    const sleep = vi.fn(async () => {});
    expect(await withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, sleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("honors retryAfterMs when present", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (n++ < 1) throw new RateLimitError("429", 5000);
      return "ok";
    });
    const sleep = vi.fn(async () => {});
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, sleep });
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("does NOT retry non-rate errors", async () => {
    const fn = vi.fn(async () => { throw new Error("boom"); });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} }))
      .rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rethrows the last rate error", async () => {
    const fn = vi.fn(async () => { throw new RateLimitError("still 429"); });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} }))
      .rejects.toThrow("still 429");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
