// app/routes/__tests__/dashboard.api.designer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import type * as HttpServer from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import { action, config } from "../dashboard.api.designer";

const { sessionMock, settingsMock, turnMock, rateLimitMock, releaseRateLimitMock, guardMock, buildStateMock, firstBuildMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  settingsMock: vi.fn(),
  turnMock: vi.fn(),
  rateLimitMock: vi.fn(),
  releaseRateLimitMock: vi.fn(),
  guardMock: vi.fn(),
  buildStateMock: vi.fn(),
  firstBuildMock: vi.fn(),
}));

vi.mock("~/lib/dashboard/http.server", async (orig) => {
  const actual = await orig<typeof HttpServer>();
  return { ...actual, requireSameOrigin: vi.fn(), rateLimit: rateLimitMock, releaseRateLimit: releaseRateLimitMock };
});
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: settingsMock }));
vi.mock("~/lib/designer/engine.server", () => ({
  designerTurn: turnMock,
  designerFirstBuild: firstBuildMock,
  designerBuildState: buildStateMock,
}));
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
  buildStateMock.mockReset().mockResolvedValue({ hasDocuments: true, unbuiltRoutes: [] });
  releaseRateLimitMock.mockReset().mockResolvedValue(undefined);
  firstBuildMock.mockReset().mockResolvedValue({ reply: "Built.", changed: true, rejectedEdits: 0 });
});

describe("dashboard.api.designer action", () => {
  it("keeps the platform deadline generous for the multi-page first build", () => {
    expect(config.maxDuration).toBe(800);
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

  it("returns the AI generation guard error as JSON before the turn", async () => {
    guardMock.mockRejectedValue(new CalderynError({
      code: "ai_cooldown",
      status: 429,
      message: "Going a little fast — try again in 20 seconds.",
    }));

    const res = await post({ message: "hi" });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "ai_cooldown",
      message: "Going a little fast — try again in 20 seconds.",
    });
    expect(turnMock).not.toHaveBeenCalled();
  });

  it("422s on an unknown mode", async () => {
    expect((await post({ message: "hi", mode: "remix" })).status).toBe(422);
    expect(firstBuildMock).not.toHaveBeenCalled();
  });

  it("409s when a first build is already running for the shop", async () => {
    buildStateMock.mockResolvedValue({ hasDocuments: false, unbuiltRoutes: [] });
    rateLimitMock.mockImplementation(async (key: string) => !key.startsWith("designer-build:"));
    const res = await post({ message: "Build my store" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("build_running");
    expect(firstBuildMock).not.toHaveBeenCalled();
  });

  it("streams the first build as NDJSON page events ending in done", async () => {
    buildStateMock.mockResolvedValue({ hasDocuments: false, unbuiltRoutes: [] });
    firstBuildMock.mockImplementation(async ({ onEvent }) => {
      onEvent?.({ kind: "page", page: "home", index: 1, total: 5, reply: "Home ready." });
      onEvent?.({ kind: "page", page: "collection", index: 2, total: 5, reply: "Collection ready." });
      return { reply: "All pages ready.", changed: true, rejectedEdits: 0 };
    });

    const res = await post({ message: "Build my store", mode: "scratch", model: "opus" });

    expect(res.headers.get("content-type")).toContain("ndjson");
    const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ kind: "page", page: "home", index: 1 });
    expect(lines[1]).toMatchObject({ kind: "page", page: "collection", index: 2 });
    expect(lines[lines.length - 1]).toMatchObject({ kind: "done", reply: "All pages ready.", changed: true });
    expect(firstBuildMock).toHaveBeenCalledWith(expect.objectContaining({ shopId: "s1", mode: "scratch", model: "opus" }));
    expect(turnMock).not.toHaveBeenCalled();
  });

  it("resumes an interrupted build as a stream instead of a single-page edit turn", async () => {
    buildStateMock.mockResolvedValue({ hasDocuments: true, unbuiltRoutes: ["cart", "checkout"] });
    firstBuildMock.mockImplementation(async ({ onEvent }) => {
      onEvent?.({ kind: "page", page: "cart", index: 5, total: 6, reply: "Cart ready." });
      return { reply: "Every page is designed.", changed: true, rejectedEdits: 0 };
    });

    const res = await post({ message: "keep going" });

    expect(res.headers.get("content-type")).toContain("ndjson");
    expect(firstBuildMock).toHaveBeenCalled();
    expect(turnMock).not.toHaveBeenCalled();
    expect(releaseRateLimitMock).toHaveBeenCalledWith("designer-build:s1");
  });

  it("returns the quota guard refusal as plain JSON on a first build, never a stream", async () => {
    buildStateMock.mockResolvedValue({ hasDocuments: false, unbuiltRoutes: [] });
    guardMock.mockRejectedValue(new CalderynError({ code: "ai_quota", status: 402, message: "Out of credits." }));

    const res = await post({ message: "Build my store" });

    expect(res.status).toBe(402);
    expect(res.headers.get("content-type") ?? "").not.toContain("ndjson");
    expect(await res.json()).toEqual({ error: "ai_quota", message: "Out of credits." });
    expect(firstBuildMock).not.toHaveBeenCalled();
  });

  it("reports a mid-build failure as an error event on the stream", async () => {
    buildStateMock.mockResolvedValue({ hasDocuments: false, unbuiltRoutes: [] });
    firstBuildMock.mockImplementation(async ({ onEvent }) => {
      onEvent?.({ kind: "page", page: "home", index: 1, total: 5, reply: "Home ready." });
      throw new Error("model fell over");
    });

    const res = await post({ message: "Build my store" });
    const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ kind: "page", page: "home" });
    expect(lines[lines.length - 1].kind).toBe("error");
  });
});
