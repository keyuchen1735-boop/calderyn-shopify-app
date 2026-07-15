import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { action } from "../dashboard.builder.generate";
import { StorefrontBuildError } from "~/lib/storefront-bundle/build.server";
import { CalderynError } from "~/lib/calderyn.server";

const { sessionMock, buildMock, prepareMock, rateLimitMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  buildMock: vi.fn(),
  prepareMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({ requireVerifiedSession: sessionMock }));
vi.mock("~/lib/dashboard/http.server", () => ({ requireSameOrigin: () => {}, rateLimit: rateLimitMock }));
vi.mock("~/lib/ai-quota.server", () => ({ quotaTrusted: () => false }));
vi.mock("~/lib/storefront-bundle/build.server", () => ({
  prepareStorefrontDesignBuild: prepareMock,
  buildStorefrontDesign: buildMock,
  StorefrontBuildError: class StorefrontBuildError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));
vi.mock("~/lib/storefront-bundle/release.server", () => ({
  StorefrontReleaseError: class StorefrontReleaseError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));

const realShop = "11111111-1111-1111-1111-111111111111";
beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ shopId: realShop, userId: "user-1" });
  prepareMock.mockReset().mockResolvedValue({ evidence: {}, resolution: { kind: "recipe" }, pointers: { draftVersionId: null, publishedVersionId: null } });
  buildMock.mockReset().mockResolvedValue({ runtime: 1, versionId: "version-1", status: "draft", resolution: { kind: "recipe" } });
  rateLimitMock.mockReset().mockResolvedValue(true);
});

const post = (body: Record<string, string>) =>
  ({ request: new Request("https://app/dashboard/builder/generate", { method: "POST", body: new URLSearchParams(body) }), params: {}, context: {} } as never);

function productionSources(root: string): Array<{ path: string; source: string }> {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") return [];
      return productionSources(path);
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.test\.[^.]+$/.test(entry.name)) return [];
    return [{ path: relative(process.cwd(), path).replaceAll("\\", "/"), source: readFileSync(path, "utf8") }];
  });
}

describe("runtime-1 builder generate action", () => {
  it("prepares and installs through runtime 1, then redirects to the runtime-1 preview", async () => {
    const res = await action(post({ mode: "catalog" }));
    expect(prepareMock).toHaveBeenCalledWith(expect.objectContaining({
      shopId: realShop,
      request: { mode: "auto", prompt: "" },
      trusted: false,
    }));
    expect(buildMock).toHaveBeenCalledWith(expect.objectContaining({
      shopId: realShop,
      actorId: "user-1",
      request: { mode: "auto", prompt: "" },
      prepared: expect.any(Object),
    }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/store/preview?route=home");
  });

  it("routes a brief through the prompt-first runtime-1 resolver", async () => {
    await action(post({ mode: "brief", brief: "  minimalist skincare  " }));
    expect(prepareMock).toHaveBeenCalledWith(expect.objectContaining({
      request: { mode: "auto", prompt: "minimalist skincare" },
    }));
  });

  it("rejects invalid input and rate limits before preparing a build", async () => {
    await expect(action(post({ mode: "wat" }))).rejects.toMatchObject({ status: 400 });
    rateLimitMock.mockResolvedValueOnce(false);
    await expect(action(post({ mode: "catalog" }))).rejects.toMatchObject({ status: 429 });
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it("returns truthful preflight errors before any runtime-1 mutation", async () => {
    prepareMock.mockRejectedValueOnce(new StorefrontBuildError("storefront_recipe_build_disabled", "Builds are disabled.", 503));
    await expect(action(post({ mode: "catalog" }))).rejects.toMatchObject({ status: 503 });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("preserves a custom-build quota status from the preflight", async () => {
    prepareMock.mockRejectedValueOnce(new CalderynError({ code: "quota_exceeded", message: "Daily limit reached.", status: 429 }));
    const error = await action(post({ mode: "brief", brief: "Build a completely original store from scratch" })).catch((caught) => caught);
    expect(error).toBeInstanceOf(Response);
    expect(error).toMatchObject({ status: 429 });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it("has no production caller that can start a new legacy generateStore build", () => {
    const offenders = productionSources(join(process.cwd(), "app"))
      .filter(({ path }) => !path.startsWith("app/lib/storegen/"))
      .filter(({ source }) => /\bgenerateStore\b/.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
