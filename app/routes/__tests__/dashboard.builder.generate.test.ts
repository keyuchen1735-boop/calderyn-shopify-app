// app/routes/__tests__/dashboard.builder.generate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const { sessionMock, generateMock } = vi.hoisted(() => ({ sessionMock: vi.fn(), generateMock: vi.fn() }));
vi.mock("~/lib/dashboard/session.server", () => ({ getSessionOrRedirect: sessionMock }));
vi.mock("~/lib/storegen/generate.server", () => ({ generateStore: generateMock }));

import { action } from "../dashboard.builder.generate";
const realShop = "11111111-1111-1111-1111-111111111111";
beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ shopId: realShop });
  generateMock.mockReset().mockResolvedValue({ runId: "r1", status: "draft", tokenCost: 1, docs: {} });
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
});
