// app/routes/__tests__/dashboard.builder.generate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { action } from "../dashboard.builder.generate";

const { sessionMock, generateMock, rateLimitMock, runningMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  generateMock: vi.fn(),
  rateLimitMock: vi.fn(),
  runningMock: vi.fn(),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireVerifiedSession: sessionMock }));
vi.mock("~/lib/dashboard/http.server", () => ({ requireSameOrigin: () => {}, rateLimit: rateLimitMock }));
vi.mock("~/lib/ai-quota.server", () => ({
  checkAiQuota: vi.fn().mockResolvedValue({ allowed: true }),
  quotaTrusted: () => false,
}));
vi.mock("~/lib/storegen/generate.server", () => ({ generateStore: generateMock }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  hasRunningExperiment: runningMock,
  expireOverdueExperiment: vi.fn(async () => undefined),
}));

const realShop = "11111111-1111-1111-1111-111111111111";
beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ shopId: realShop });
  generateMock.mockReset().mockResolvedValue({ runId: "r1", status: "draft", tokenCost: 1, docs: {} });
  rateLimitMock.mockReset().mockResolvedValue(true);
  runningMock.mockReset().mockResolvedValue(false);
});
const post = (body: Record<string, string>) =>
  ({ request: new Request("https://app/dashboard/builder/generate", { method: "POST", body: new URLSearchParams(body) }), params: {}, context: {} } as never);

describe("generate action", () => {
  it("validates mode and calls generateStore, then redirects to the preview", async () => {
    const res = await action(post({ mode: "catalog" }));
    expect(generateMock).toHaveBeenCalledWith({ shopId: realShop, mode: "catalog", brief: undefined });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/builder/preview");
  });
  it("rejects an invalid mode at the boundary", async () => {
    await expect(action(post({ mode: "wat" }))).rejects.toBeInstanceOf(Response);
  });
  it("passes the brief through in brief mode", async () => {
    await action(post({ mode: "brief", brief: "minimalist skincare" }));
    expect(generateMock).toHaveBeenCalledWith({ shopId: realShop, mode: "brief", brief: "minimalist skincare" });
  });
  it("shares the storegen rate limit with the API route and 429s when exhausted", async () => {
    rateLimitMock.mockResolvedValue(false);
    await expect(action(post({ mode: "catalog" }))).rejects.toMatchObject({ status: 429 });
    expect(rateLimitMock).toHaveBeenCalledWith(`storegen:${realShop}`, 5, 60_000);
    expect(generateMock).not.toHaveBeenCalled();
  });
  it("caps the brief at 4000 chars before spending on generation", async () => {
    await expect(action(post({ mode: "brief", brief: "x".repeat(4001) }))).rejects.toMatchObject({
      status: 422,
    });
    expect(generateMock).not.toHaveBeenCalled();
  });
  it("409s while an experiment is running instead of regenerating under the test", async () => {
    runningMock.mockResolvedValue(true);
    await expect(action(post({ mode: "catalog" }))).rejects.toMatchObject({ status: 409 });
    expect(generateMock).not.toHaveBeenCalled();
  });
});
