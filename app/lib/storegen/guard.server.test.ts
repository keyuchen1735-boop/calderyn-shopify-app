import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeGenerateQuotaReservation, reserveGenerateQuota } from "./guard.server";

const mocks = vi.hoisted(() => ({ rateLimit: vi.fn(), hasRunning: vi.fn(), expire: vi.fn(), quota: vi.fn() }));
vi.mock("~/lib/dashboard/http.server", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  hasRunningExperiment: mocks.hasRunning,
  expireOverdueExperiment: mocks.expire,
}));
vi.mock("~/lib/ai-quota.server", () => ({ checkAiQuota: mocks.quota }));

beforeEach(() => {
  mocks.rateLimit.mockReset().mockResolvedValue(true);
  mocks.hasRunning.mockReset().mockResolvedValue(false);
  mocks.expire.mockReset().mockResolvedValue(undefined);
  mocks.quota.mockReset().mockResolvedValue({ allowed: true });
});

describe("storefront generation quota reservation", () => {
  it("charges once before streaming and consumes a prompt-bound token exactly once", async () => {
    const token = await reserveGenerateQuota("shop-1", "Original store", { trusted: true });
    expect(mocks.quota).toHaveBeenCalledTimes(1);
    expect(() => consumeGenerateQuotaReservation({ token, shopId: "shop-1", prompt: "Original store" })).not.toThrow();
    expect(() => consumeGenerateQuotaReservation({ token, shopId: "shop-1", prompt: "Original store" }))
      .toThrow(/reservation expired/i);
    expect(mocks.quota).toHaveBeenCalledTimes(1);
  });

  it("rejects a token replayed for a different prompt", async () => {
    const token = await reserveGenerateQuota("shop-1", "First", { trusted: false });
    expect(() => consumeGenerateQuotaReservation({ token, shopId: "shop-1", prompt: "Second" }))
      .toThrow(/reservation expired/i);
  });
});
