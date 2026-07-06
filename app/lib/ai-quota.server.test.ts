import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ rateLimit: vi.fn() }));

vi.mock("./rate-limit.server", () => ({ rateLimit: h.rateLimit }));

// eslint-disable-next-line import/first -- import must follow vi.mock so the limiter fake registers first
import { checkAiQuota, quotaTrusted } from "./ai-quota.server";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("checkAiQuota", () => {
  it("is unmetered in local development, skipping both buckets", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const verdict = await checkAiQuota({ shopId: "shop-1", feature: "designer", trusted: false });
    expect(verdict.allowed).toBe(true);
    expect(h.rateLimit).not.toHaveBeenCalled();
  });

  it("is unmetered for a shop in AI_QUOTA_BYPASS_SHOPS, even in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_QUOTA_BYPASS_SHOPS", "shop-a, shop-b");
    const verdict = await checkAiQuota({ shopId: "shop-b", feature: "designer", trusted: false });
    expect(verdict.allowed).toBe(true);
    expect(h.rateLimit).not.toHaveBeenCalled();
  });

  it("still caps a production shop that is not on the allowlist", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_QUOTA_BYPASS_SHOPS", "shop-a");
    h.rateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const verdict = await checkAiQuota({ shopId: "shop-z", feature: "designer", trusted: false });
    expect(verdict).toMatchObject({ allowed: false, code: "ai_daily_limit" });
    expect(h.rateLimit).toHaveBeenCalledTimes(2);
  });

  it("allows when both buckets are within limits, touching cooldown then daily", async () => {
    h.rateLimit.mockResolvedValue(true);
    const verdict = await checkAiQuota({ shopId: "shop-1", feature: "designer", trusted: false });
    expect(verdict.allowed).toBe(true);
    expect(h.rateLimit).toHaveBeenNthCalledWith(1, "ai:cd:designer:shop-1", 1, 20_000);
    expect(h.rateLimit).toHaveBeenNthCalledWith(2, "ai:day:designer:shop-1", 5, 86_400_000);
  });

  it("blocks on cooldown without touching the daily allowance", async () => {
    h.rateLimit.mockResolvedValueOnce(false);
    const verdict = await checkAiQuota({ shopId: "shop-1", feature: "assistant", trusted: true });
    expect(verdict).toMatchObject({ allowed: false, code: "ai_cooldown" });
    expect(h.rateLimit).toHaveBeenCalledTimes(1);
  });

  it("blocks on the daily cap using the trusted tier's higher limit", async () => {
    h.rateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const verdict = await checkAiQuota({ shopId: "shop-1", feature: "assistant", trusted: true });
    expect(verdict).toMatchObject({ allowed: false, code: "ai_daily_limit" });
    expect(h.rateLimit).toHaveBeenNthCalledWith(2, "ai:day:assistant:shop-1", 300, 86_400_000);
  });

  it("uses the base cap for untrusted shops", async () => {
    h.rateLimit.mockResolvedValue(true);
    await checkAiQuota({ shopId: "s", feature: "assistant", trusted: false });
    expect(h.rateLimit).toHaveBeenNthCalledWith(2, "ai:day:assistant:s", 30, 86_400_000);
  });
});

describe("quotaTrusted", () => {
  it("trusts Shopify-embedded sessions (no users row)", () => {
    expect(quotaTrusted({ userId: null, accountCreatedAt: null })).toBe(true);
  });

  it("keeps young first-party accounts on the base tier", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(quotaTrusted({ userId: "u1", accountCreatedAt: yesterday })).toBe(false);
  });

  it("trusts first-party accounts older than seven days", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    expect(quotaTrusted({ userId: "u1", accountCreatedAt: eightDaysAgo })).toBe(true);
  });

  it("treats a missing created_at as untrusted", () => {
    expect(quotaTrusted({ userId: "u1", accountCreatedAt: null })).toBe(false);
  });
});
