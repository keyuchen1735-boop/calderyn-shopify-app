// app/routes/__tests__/dashboard.api.store.generate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import type * as HttpServer from "~/lib/dashboard/http.server";
import { action, config } from "../dashboard.api.store.generate";
import { StorefrontBuildError } from "~/lib/storefront-bundle/build.server";

const { sessionMock, buildMock, prepareMock, rateLimitMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  buildMock: vi.fn(),
  prepareMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock("~/lib/calderyn.server", () => ({
  CalderynError: class CalderynError extends Error {
    code: string;
    status: number;
    constructor(o: { code: string; status: number; message: string }) {
      super(o.message);
      this.name = "CalderynError";
      this.code = o.code;
      this.status = o.status;
    }
  },
}));
vi.mock("~/lib/dashboard/http.server", async (orig) => {
  const actual = await orig<typeof HttpServer>();
  return { ...actual, requireSameOrigin: vi.fn(), rateLimit: rateLimitMock };
});
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/storefront-bundle/build.server", () => ({
  buildStorefrontDesign: buildMock,
  prepareStorefrontDesignBuild: prepareMock,
  StorefrontBuildError: class StorefrontBuildError extends Error {
    constructor(public code: string, message: string, public status: number) {
      super(message);
    }
  },
}));
vi.mock("~/lib/ai-quota.server", () => ({ quotaTrusted: () => true }));
vi.mock("~/lib/storefront-bundle/release.server", () => ({
  StorefrontReleaseError: class StorefrontReleaseError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));

const post = (body: unknown) =>
  action({
    request: new Request("https://x.test/dashboard/api/store/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as ActionFunctionArgs);

const lines = async (res: Response) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ shopId: "s1", userId: "u1" });
  buildMock.mockReset();
  prepareMock.mockReset().mockResolvedValue({ evidence: {}, resolution: { kind: "recipe" }, pointers: { draftVersionId: null, publishedVersionId: null } });
  rateLimitMock.mockReset().mockResolvedValue(true);
});

describe("dashboard.api.store.generate streaming action", () => {
  it("keeps the platform deadline beyond the generator's ten-minute budget", () => {
    expect(config.maxDuration).toBe(800);
  });

  it("routes runtime-1 design requests without invoking the legacy generator or its AI quota", async () => {
    const frozen = {
      kind: "recipe",
      templateId: "commons-index",
      templateVersion: 1,
      selectionKind: "niche_match",
      routingVersion: 1,
      registryVersion: 1,
      catalogFingerprint: "sha256:fresh",
      score: 12,
      runnerUpScore: 0,
      margin: 12,
      confidenceBand: "high",
      breakdown: [],
      reasons: ["refill match"],
    };
    buildMock.mockImplementation(async (input: { onEvent?: (event: unknown) => void }) => {
      input.onEvent?.({ stage: "routing", resolution: frozen, recommendationChanged: false });
      input.onEvent?.({ stage: "applying_recipe", templateId: "commons-index", templateVersion: 1 });
      input.onEvent?.({ stage: "compiling" });
      input.onEvent?.({ stage: "validating" });
      input.onEvent?.({ stage: "proofing" });
      const receipt = { runtime: 1, versionId: "version-1", status: "draft", resolution: frozen };
      input.onEvent?.({ stage: "installed", receipt });
      return receipt;
    });

    const res = await post({
      designRequest: { prompt: "Build a sustainable refill shop", mode: "auto" },
      recommendedResolution: { ...frozen, catalogFingerprint: "sha256:stale" },
    });
    const events = await lines(res);

    expect(events.map((event) => event.stage)).toEqual([
      "routing", "applying_recipe", "compiling", "validating", "proofing", "installed",
    ]);
    expect(events[0].resolution).toEqual(frozen);
    expect(buildMock).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "s1",
      actorId: "u1",
      request: { prompt: "Build a sustainable refill shop", mode: "auto" },
      recommendedResolution: expect.objectContaining({ catalogFingerprint: "sha256:stale" }),
      onEvent: expect.any(Function),
    }));
    expect(prepareMock).toHaveBeenCalledWith(expect.objectContaining({ shopId: "s1" }));
  });

  it("rejects an invalid runtime-1 design contract before opening a stream", async () => {
    const res = await post({ designRequest: { prompt: "", mode: "recipe" } });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_design_request" });
    expect(buildMock).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("returns preflight write and flag failures before opening a stream", async () => {
    prepareMock.mockRejectedValueOnce(new StorefrontBuildError("experiment_running", "Finish the test first.", 409));
    const res = await post({ designRequest: { prompt: "Build a sustainable refill shop", mode: "auto" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "experiment_running", message: "Finish the test first." });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("applies a bounded per-shop recipe build rate limit before routing or AI quota billing", async () => {
    rateLimitMock.mockResolvedValueOnce(false);
    const res = await post({ designRequest: { prompt: "refills", mode: "auto" } });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(rateLimitMock).toHaveBeenCalledWith("storefront-build:s1", 10, 60_000);
    expect(prepareMock).not.toHaveBeenCalled();
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid model with 422 before generating", async () => {
    const res = await post({ designRequest: { prompt: "x", mode: "gpt" } });
    expect(res.status).toBe(422);
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("preserves a post-stream release conflict as an in-band code and status", async () => {
    buildMock.mockImplementation(async (input: { onEvent?: (event: unknown) => void }) => {
      input.onEvent?.({ stage: "routing", resolution: { kind: "recipe" }, recommendationChanged: false });
      throw new StorefrontBuildError("storefront_draft_conflict", "The draft changed. Try again.", 409);
    });
    const res = await post({ designRequest: { prompt: "refills", mode: "auto" } });
    const events = await lines(res);
    expect(events[0].stage).toBe("routing");
    const last = events[events.length - 1];
    expect(last).toEqual({ stage: "error", code: "storefront_draft_conflict", status: 409, message: "The draft changed. Try again." });
  });
});
