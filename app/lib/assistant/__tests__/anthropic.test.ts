import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("assistantModel", () => {
  const OLD = { ...process.env };
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("returns ANTHROPIC_MODEL when set", async () => {
    process.env.ANTHROPIC_MODEL = "claude-test-xyz";
    const { assistantModel } = await import("../anthropic.server");
    expect(assistantModel()).toBe("claude-test-xyz");
  });

  it("falls back to DEFAULT_ASSISTANT_MODEL when unset", async () => {
    delete process.env.ANTHROPIC_MODEL;
    const mod = await import("../anthropic.server");
    expect(mod.assistantModel()).toBe(mod.DEFAULT_ASSISTANT_MODEL);
  });

  it("getAnthropic throws when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { getAnthropic } = await import("../anthropic.server");
    expect(() => getAnthropic()).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("digestModel", () => {
  const OLD = { ...process.env };
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("returns DIGEST_MODEL when set", async () => {
    process.env.DIGEST_MODEL = "claude-digest-xyz";
    const { digestModel } = await import("../anthropic.server");
    expect(digestModel()).toBe("claude-digest-xyz");
  });

  it("defaults the digest crons to Haiku when DIGEST_MODEL is unset", async () => {
    delete process.env.DIGEST_MODEL;
    const mod = await import("../anthropic.server");
    expect(mod.digestModel()).toBe(mod.DEFAULT_DIGEST_MODEL);
    expect(mod.DEFAULT_DIGEST_MODEL).toContain("haiku");
  });
});
