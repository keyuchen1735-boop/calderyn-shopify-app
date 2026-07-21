import { beforeEach, describe, expect, it, vi } from "vitest";

const { rateLimitMock } = vi.hoisted(() => ({ rateLimitMock: vi.fn() }));
vi.mock("../rate-limit.server", () => ({ rateLimit: rateLimitMock }));

// eslint-disable-next-line import/first -- import must follow vi.mock so the limiter fake registers first
import { checkAiQuota } from "../ai-quota.server";
// eslint-disable-next-line import/first -- import must follow vi.mock so the limiter fake registers first
import { DEFAULT_DIGEST_MODEL, radarDraftModel } from "../assistant/anthropic.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  // vitest runs with NODE_ENV=test, so the development bypass stays off; keep
  // the env allowlist empty so the quota path is actually exercised.
  delete process.env.AI_QUOTA_BYPASS_SHOPS;
});

describe("radar AiFeature", () => {
  it("has no cooldown: back-to-back calls only touch the daily bucket", async () => {
    rateLimitMock.mockResolvedValue(true);
    const verdict = await checkAiQuota({ shopId: SHOP, feature: "radar", trusted: true });
    expect(verdict).toEqual({ allowed: true });
    expect(rateLimitMock).toHaveBeenCalledTimes(1);
    expect(rateLimitMock).toHaveBeenCalledWith(`ai:day:radar:${SHOP}`, 5, 86_400_000);
    expect(rateLimitMock).not.toHaveBeenCalledWith(expect.stringContaining("ai:cd:radar"), expect.anything(), expect.anything());
  });
  it("caps at 5 per day for both tiers", async () => {
    rateLimitMock.mockResolvedValue(false);
    const base = await checkAiQuota({ shopId: SHOP, feature: "radar", trusted: false });
    expect(base).toMatchObject({ allowed: false, code: "ai_daily_limit" });
    expect(rateLimitMock).toHaveBeenLastCalledWith(`ai:day:radar:${SHOP}`, 5, 86_400_000);
    await checkAiQuota({ shopId: SHOP, feature: "radar", trusted: true });
    expect(rateLimitMock).toHaveBeenLastCalledWith(`ai:day:radar:${SHOP}`, 5, 86_400_000);
  });
  it("leaves features with a cooldown untouched", async () => {
    rateLimitMock.mockResolvedValue(true);
    await checkAiQuota({ shopId: SHOP, feature: "assistant", trusted: false });
    expect(rateLimitMock).toHaveBeenCalledWith(`ai:cd:assistant:${SHOP}`, 1, 4_000);
  });
});

describe("radarDraftModel", () => {
  it("defaults to the digest-class model and honors the env override", () => {
    delete process.env.RADAR_DRAFT_MODEL;
    expect(radarDraftModel()).toBe(DEFAULT_DIGEST_MODEL);
    process.env.RADAR_DRAFT_MODEL = "env-model";
    expect(radarDraftModel()).toBe("env-model");
    delete process.env.RADAR_DRAFT_MODEL;
  });
});
