// app/routes/__tests__/dashboard.api.store.generate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import type * as HttpServer from "~/lib/dashboard/http.server";
import { action } from "../dashboard.api.store.generate";
import { CalderynError } from "~/lib/calderyn.server";

const { sessionMock, assertGenMock, generateMock, buildMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  assertGenMock: vi.fn(),
  generateMock: vi.fn(),
  buildMock: vi.fn(),
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
  return { ...actual, requireSameOrigin: vi.fn() };
});
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: sessionMock }));
vi.mock("~/lib/storegen/guard.server", () => ({ assertCanGenerate: assertGenMock }));
vi.mock("~/lib/storegen/generate.server", () => ({ generateStore: generateMock }));
vi.mock("~/lib/storefront-bundle/build.server", () => ({
  buildStorefrontDesign: buildMock,
  StorefrontBuildError: class StorefrontBuildError extends Error {
    constructor(public code: string, message: string, public status: number) {
      super(message);
    }
  },
}));
vi.mock("~/lib/ai-quota.server", () => ({ quotaTrusted: () => true }));

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
  assertGenMock.mockReset().mockResolvedValue(undefined);
  generateMock.mockReset();
  buildMock.mockReset();
});

describe("dashboard.api.store.generate streaming action", () => {
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
    expect(generateMock).not.toHaveBeenCalled();
    expect(assertGenMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid runtime-1 design contract before opening a stream", async () => {
    const res = await post({ designRequest: { prompt: "", mode: "recipe" } });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_design_request" });
    expect(buildMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("streams each real stage as NDJSON, ending with the receipt", async () => {
    generateMock.mockImplementation(async (input: { onStage?: (s: string) => void }) => {
      input.onStage?.("brand");
      input.onStage?.("designing");
      input.onStage?.("checking");
      return {
        runId: "r1",
        status: "draft",
        tokenCost: 5,
        docs: {},
        verification: { checkedLinks: 3, fixedLinks: 1, externalLinks: 0, strippedMotion: 0, warnings: [] },
      };
    });
    const res = await post({ brief: "medical devices" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");
    const events = await lines(res);
    expect(events.map((e) => e.stage)).toEqual(["brand", "designing", "checking", "done"]);
    expect(events[3].receipt).toEqual({
      runId: "r1",
      status: "draft",
      verification: { checkedLinks: 3, fixedLinks: 1, externalLinks: 0, strippedMotion: 0, warnings: [] },
    });
  });

  it("rejects with plain JSON before any generation when the guard refuses", async () => {
    assertGenMock.mockRejectedValue(new CalderynError({ code: "rate_limited", status: 429, message: "slow down" }));
    const res = await post({ brief: "x" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid model with 422 before generating", async () => {
    const res = await post({ brief: "x", model: "gpt" });
    expect(res.status).toBe(422);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("reports a mid-run failure as an in-band error line, never a dead stream", async () => {
    generateMock.mockImplementation(async (input: { onStage?: (s: string) => void }) => {
      input.onStage?.("brand");
      throw new Error("api down");
    });
    const res = await post({ brief: "x" });
    const events = await lines(res);
    expect(events[0]).toEqual({ stage: "brand" });
    const last = events[events.length - 1];
    expect(last.stage).toBe("error");
    expect(typeof last.message).toBe("string");
    // upstream detail is not leaked verbatim to the browser
    expect(last.message).not.toContain("api down");
  });
});
