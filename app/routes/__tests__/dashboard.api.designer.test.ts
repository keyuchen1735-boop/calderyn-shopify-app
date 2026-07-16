// app/routes/__tests__/dashboard.api.designer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import type * as HttpServer from "~/lib/dashboard/http.server";
import { action, config } from "../dashboard.api.designer";

const { sessionMock, settingsMock, turnMock, rateLimitMock, guardMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  settingsMock: vi.fn(),
  turnMock: vi.fn(),
  rateLimitMock: vi.fn(),
  guardMock: vi.fn(),
}));

vi.mock("~/lib/dashboard/http.server", async (orig) => {
  const actual = await orig<typeof HttpServer>();
  return { ...actual, requireSameOrigin: vi.fn(), rateLimit: rateLimitMock };
});
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: settingsMock }));
vi.mock("~/lib/designer/engine.server", () => ({ designerTurn: turnMock }));
vi.mock("~/lib/ai-quota.server", () => ({ quotaTrusted: () => true }));
vi.mock("~/lib/storegen/guard.server", () => ({ assertCanGenerate: guardMock }));

const post = (body: unknown) =>
  action({
    request: new Request("https://x.test/dashboard/api/designer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as ActionFunctionArgs);

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ shopId: "s1", userId: "u1" });
  settingsMock.mockReset().mockResolvedValue({ composerEnabled: true });
  turnMock.mockReset().mockResolvedValue({ reply: "Done.", changed: true, rejectedEdits: 0 });
  rateLimitMock.mockReset().mockResolvedValue(true);
  guardMock.mockReset().mockResolvedValue(undefined);
});

describe("dashboard.api.designer action", () => {
  it("keeps the platform deadline generous for multi-call turns", () => {
    expect(config.maxDuration).toBe(300);
  });

  it("runs a designer turn and returns its result", async () => {
    const res = await post({ message: "Make the hero better", page: "home", model: "opus" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "Done.", changed: true, rejectedEdits: 0 });
    expect(turnMock).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: "s1", message: "Make the hero better", route: "home", model: "opus" }),
    );
  });

  it("409s when the Labs designer flag is off, before any model call", async () => {
    settingsMock.mockResolvedValue({ composerEnabled: false });
    const res = await post({ message: "hello" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("designer_disabled");
    expect(turnMock).not.toHaveBeenCalled();
  });

  it("422s on an empty or oversized message", async () => {
    expect((await post({ message: "   " })).status).toBe(422);
    expect((await post({ message: "x".repeat(4_001) })).status).toBe(422);
    expect(turnMock).not.toHaveBeenCalled();
  });

  it("422s on an unknown model or page", async () => {
    expect((await post({ message: "hi", model: "gpt" })).status).toBe(422);
    expect((await post({ message: "hi", page: "blog" })).status).toBe(422);
    expect(turnMock).not.toHaveBeenCalled();
  });

  it("422s on a non-object body", async () => {
    const res = await action({
      request: new Request("https://x.test/dashboard/api/designer", { method: "POST", body: "not json" }),
      params: {},
      context: {},
    } as ActionFunctionArgs);
    expect(res.status).toBe(422);
  });

  it("429s when the per-shop rate limit trips", async () => {
    rateLimitMock.mockResolvedValue(false);
    const res = await post({ message: "hi" });
    expect(res.status).toBe(429);
    expect(turnMock).not.toHaveBeenCalled();
  });

  it("enforces the AI generation guard before the turn", async () => {
    guardMock.mockRejectedValue(new Error("quota"));
    await expect(post({ message: "hi" })).rejects.toThrow("quota");
    expect(turnMock).not.toHaveBeenCalled();
  });
});
