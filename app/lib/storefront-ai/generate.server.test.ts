import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { createConcept, createContext, createExpansion, PASSING_JUDGE_SCORES, TEST_SHOP_ID, TEST_VERSION_ID } from "./__fixtures__/deterministic";
import type { GenerateDependencies, GenerationCheckpoint, StorefrontAiProvider } from "./contracts";
import { generateOriginalStorefront } from "./generate.server";

function passingDependencies(overrides: Partial<GenerateDependencies> = {}): GenerateDependencies {
  const provider: StorefrontAiProvider = {
    complete: vi.fn(async (request) => {
      const strategyIndex = request.prompt.includes("spatial-catalog") ? 2 : request.prompt.includes("narrative-utility") ? 1 : 0;
      if (request.operation === "concept" || request.operation === "repairConcept") return { value: createConcept(strategyIndex), usage: { inputTokens: 10, outputTokens: 20 }, provider: "fixture", model: "fixture" };
      if (request.operation === "judge") return { value: { scores: PASSING_JUDGE_SCORES, rationale: "clear" }, usage: { inputTokens: 5, outputTokens: 5 }, provider: "fixture", model: "fixture" };
      if (request.operation === "expand") return { value: createExpansion(), usage: { inputTokens: 10, outputTokens: 20 }, provider: "fixture", model: "fixture" };
      throw new Error(`unexpected ${request.operation}`);
    }),
  };
  return {
    enabled: () => true,
    preflight: vi.fn(async () => undefined),
    assembleContext: vi.fn(async () => createContext()),
    provider,
    compileConcept: (candidate) => ({ candidate, compiledFingerprint: candidate.candidateId }),
    renderConcept: vi.fn(async () => ({ desktop: "desktop", mobile: "mobile" })),
    produceAsset: vi.fn(async () => null),
    persistAsset: vi.fn(),
    compileBundle,
    browserProof: vi.fn(async () => ({ ok: true, diagnostics: [], screenshots: ["desktop.webp", "mobile.webp"], browserMs: 12 })),
    repairRoute: vi.fn(),
    installValidatedBundle: vi.fn(async () => ({ versionId: TEST_VERSION_ID, installedDraftVersionId: TEST_VERSION_ID })),
    checkpoint: vi.fn(async (_event: GenerationCheckpoint) => undefined),
    now: (() => { let value = 1_000; return () => value += 10; })(),
    randomId: () => "gen-deterministic",
    ...overrides,
  };
}

describe("generateOriginalStorefront", () => {
  it("checks the production kill switch before requiring provider configuration", async () => {
    vi.stubEnv("STOREFRONT_CUSTOM_BUILD", "0");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(generateOriginalStorefront({ shopId: TEST_SHOP_ID, prompt: "original", expectedDraftVersionId: null, actorId: null, trusted: true }))
      .resolves.toEqual({ status: "disabled", code: "storefront_custom_build_disabled" });
    vi.unstubAllEnvs();
  });

  it("returns an honest disabled result behind STOREFRONT_CUSTOM_BUILD without invoking old or new generation", async () => {
    const deps = passingDependencies({ enabled: () => false });
    const result = await generateOriginalStorefront({ shopId: TEST_SHOP_ID, prompt: "make it original", expectedDraftVersionId: null, actorId: null, trusted: true }, deps);
    expect(result).toEqual({ status: "disabled", code: "storefront_custom_build_disabled" });
    expect(deps.preflight).not.toHaveBeenCalled();
    expect(deps.provider.complete).not.toHaveBeenCalled();
  });

  it("compiles, proves, audits, and CAS-installs one complete winning bundle", async () => {
    const installValidatedBundle = vi.fn(async (input) => ({ versionId: TEST_VERSION_ID, installedDraftVersionId: TEST_VERSION_ID, input }));
    const checkpoint = vi.fn(async (_event: GenerationCheckpoint) => undefined);
    const deps = passingDependencies({ installValidatedBundle, checkpoint });
    const result = await generateOriginalStorefront({ shopId: TEST_SHOP_ID, prompt: "make it original", expectedDraftVersionId: null, actorId: "actor-1", trusted: true }, deps);

    expect(result.status).toBe("installed");
    if (result.status !== "installed") throw new Error("expected install");
    expect(result.bundle.source).toEqual({ kind: "custom", generationId: "gen-deterministic", promptHash: expect.stringMatching(/^sha256:/) });
    expect(Object.keys(result.bundle.routes)).toEqual(["home", "collection", "product", "search", "cart", "checkout"]);
    expect(installValidatedBundle).toHaveBeenCalledTimes(1);
    expect(installValidatedBundle).toHaveBeenCalledWith(expect.objectContaining({
      shopId: TEST_SHOP_ID,
      expectedDraftVersionId: null,
      bundle: result.bundle,
      artifactHash: result.artifactHash,
      audit: expect.objectContaining({
        generationId: "gen-deterministic",
        contextFingerprint: "sha256:test-context",
        candidateCount: 3,
        routeValidation: expect.objectContaining({ ok: true }),
        finalArtifactHash: result.artifactHash,
      }),
    }));
    expect(checkpoint.mock.calls.map(([event]) => event.stage)).toEqual(expect.arrayContaining(["context", "concepts", "judging", "expanding", "proofing", "installed"]));
  });

  it("installs only content-addressed owned asset references and records their provenance", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "concept" && request.operation !== "repairConcept") return response;
      return {
        ...response,
        value: { ...(response.value as object), assetRequests: [{ key: "hero", purpose: "original editorial hero", required: true }] },
      };
    });
    deps.produceAsset = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), provenance: "fixture:generated" }));
    deps.persistAsset = vi.fn(async () => ({ assetKey: "owned/sha256/hero.webp", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 3 }));

    const result = await generateOriginalStorefront({ shopId: TEST_SHOP_ID, prompt: "original", expectedDraftVersionId: null, actorId: null, trusted: true }, deps);
    expect(result.status).toBe("installed");
    if (result.status !== "installed") throw new Error("expected install");
    expect(result.bundle.assets.entries).toEqual([{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 3 }]);
    expect(result.audit).toMatchObject({
      assetCount: 1,
      assetProvenance: [{ logicalKey: "hero", assetKey: "owned/sha256/hero.webp", contentHash: "a".repeat(64), provenance: "fixture:generated" }],
    });
  });

  it("leaves the draft unchanged when every concept fails", async () => {
    const deps = passingDependencies({
      compileConcept: () => { throw new Error("compiler rejection"); },
    });
    const result = await generateOriginalStorefront({ shopId: TEST_SHOP_ID, prompt: "original", expectedDraftVersionId: TEST_VERSION_ID, actorId: null, trusted: true }, deps);
    expect(result.status).toBe("failed");
    expect(deps.installValidatedBundle).not.toHaveBeenCalled();
  });

  it("honors cancellation and budget checkpoints before any atomic install", async () => {
    const controller = new AbortController();
    const deps = passingDependencies({
      assembleContext: vi.fn(async () => { controller.abort(); return createContext(); }),
    });
    const result = await generateOriginalStorefront({ shopId: TEST_SHOP_ID, prompt: "original", expectedDraftVersionId: null, actorId: null, trusted: true, signal: controller.signal }, deps);
    expect(result.status).toBe("cancelled");
    expect(deps.installValidatedBundle).not.toHaveBeenCalled();

    const budgetDeps = passingDependencies();
    const budgetResult = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "original",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
      budget: { maxModelTokens: 1 },
    }, budgetDeps);
    expect(budgetResult).toMatchObject({ status: "failed", code: "generation_budget_exceeded" });
    expect(budgetDeps.installValidatedBundle).not.toHaveBeenCalled();
  });

  it("has no import or call path to legacy generateStore", () => {
    const directory = resolve(process.cwd(), "app/lib/storefront-ai");
    const files = ["provider.server.ts", "concepts.server.ts", "expand.server.ts", "generate.server.ts"];
    const source = files.map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
    expect(source).not.toMatch(/storegen\/generate|\bgenerateStore\s*\(/);
  });
});
