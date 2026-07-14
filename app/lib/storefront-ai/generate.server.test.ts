import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CURATED_FONT_IDS } from "../storefront-bundle/types";
import { compileBundle } from "../storefront-compiler/compile";
import { createConcept, createContext, createExpansion, PASSING_JUDGE_SCORES, TEST_SHOP_ID, TEST_VERSION_ID } from "./__fixtures__/deterministic";
import type { GenerateDependencies, GenerationCheckpoint, StorefrontAiProvider, StructuredModelResponse } from "./contracts";
import { generateOriginalStorefront } from "./generate.server";
import { compileConceptCandidate } from "./concepts.server";

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
    loadReferenceImages: vi.fn(async () => []),
    provider,
    compileConcept: compileConceptCandidate,
    renderConcept: vi.fn(async () => ({
      desktop: { key: "judge-desktop", mediaType: "image/webp" as const, bytes: new Uint8Array([1]) },
      mobile: { key: "judge-mobile", mediaType: "image/webp" as const, bytes: new Uint8Array([2]) },
      browserMs: 12,
    })),
    produceAsset: vi.fn(async () => null),
    persistAsset: vi.fn(),
    cleanupAsset: vi.fn(async () => undefined),
    compileBundle,
    browserProof: vi.fn(async () => ({ ok: true, diagnostics: [], screenshots: ["desktop.webp", "mobile.webp"], browserMs: 12 })),
    repairRoute: vi.fn(),
    installValidatedBundle: vi.fn(async () => ({
      versionId: TEST_VERSION_ID,
      installedDraftVersionId: TEST_VERSION_ID,
      artifactHash: `sha256:${"f".repeat(64)}`,
    })),
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

  it("consumes an existing pre-stream quota reservation without reserving again", async () => {
    const deps = passingDependencies();
    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "original",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
      quotaReservationToken: "quota-reservation-1",
    }, deps);
    expect(result.status).toBe("installed");
    expect(deps.preflight).toHaveBeenCalledOnce();
    expect(deps.preflight).toHaveBeenCalledWith(expect.objectContaining({ reservationToken: "quota-reservation-1" }));
  });

  it("compiles, proves, audits, and CAS-installs one complete winning bundle", async () => {
    const installValidatedBundle = vi.fn(async (input) => ({
      versionId: TEST_VERSION_ID,
      installedDraftVersionId: TEST_VERSION_ID,
      artifactHash: `sha256:${"f".repeat(64)}`,
      input,
    }));
    const checkpoint = vi.fn(async (_event: GenerationCheckpoint) => undefined);
    const deps = passingDependencies({ installValidatedBundle, checkpoint });
    const routingResolution = {
      kind: "custom" as const,
      reason: "explicit_custom" as const,
      routingVersion: 1,
      registryVersion: 1,
      catalogFingerprint: "sha256:test-context",
      breakdown: [],
      reasons: ["Original design requested"],
    };
    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "make it original",
      expectedDraftVersionId: null,
      actorId: "actor-1",
      trusted: true,
      routingResolution,
    }, deps);

    expect(result.status).toBe("installed");
    if (result.status !== "installed") throw new Error("expected install");
    expect(result.bundle.source).toEqual({ kind: "custom", generationId: "gen-deterministic", promptHash: expect.stringMatching(/^sha256:/) });
    expect(Object.keys(result.bundle.routes)).toEqual(["home", "collection", "product", "search", "cart", "checkout"]);
    expect(installValidatedBundle).toHaveBeenCalledTimes(1);
    expect(installValidatedBundle).toHaveBeenCalledWith(expect.objectContaining({
      shopId: TEST_SHOP_ID,
      expectedDraftVersionId: null,
      bundle: result.bundle,
      artifactHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      audit: expect.objectContaining({
        generationId: "gen-deterministic",
        contextFingerprint: "sha256:test-context",
        contextSnapshot: createContext(),
        promptContractVersion: 1,
        routingResolution,
        candidateCount: 3,
        routeValidation: expect.objectContaining({ ok: true }),
        finalArtifactHash: result.artifactHash,
      }),
    }));
    expect(checkpoint.mock.calls.map(([event]) => event.stage)).toEqual(expect.arrayContaining(["context", "concepts", "judging", "expanding", "proofing", "installed"]));
    expect(checkpoint.mock.calls.every(([event]) =>
      event.shopId === TEST_SHOP_ID && event.promptHash === createContext().promptHash &&
      !JSON.stringify(event.detail ?? {}).includes("make it original")
    )).toBe(true);
  });

  it("installs when the provider follows the trusted-slot source contract", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "expand") return response;
      const documentsSlotSyntax = request.system.includes("data-cd-slot") &&
        request.system.includes("data-cd-trusted-slot-id") &&
        request.system.includes("Any other data-cd-*");
      if (documentsSlotSyntax) return response;
      const expansion = structuredClone(response.value as ReturnType<typeof createExpansion>);
      expansion.product.html = `<main><div data-cd-trusted-slot-id="cd-product-slot-1"></div></main>`;
      return { ...response, value: expansion };
    });

    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "Create an original product-first shop",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
    }, deps);

    expect(result.status).toBe("installed");
    if (result.status !== "installed") throw new Error("expected install");
    expect(result.bundle.routes.product.html).toContain("data-cd-trusted-slot-id");
  });

  it("installs when the provider follows the curated-font source contract", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "concept" && request.operation !== "repairConcept") return response;
      const fontFields = (request.schema as {
        properties: { designSystem: { properties: {
          displayFontId: { enum?: readonly string[] };
          bodyFontId: { enum?: readonly string[] };
        } } };
      }).properties.designSystem.properties;
      const expectedFontIds = JSON.stringify(CURATED_FONT_IDS);
      if (JSON.stringify(fontFields.displayFontId.enum) === expectedFontIds &&
          JSON.stringify(fontFields.bodyFontId.enum) === expectedFontIds) return response;
      const concept = structuredClone(response.value as ReturnType<typeof createConcept>);
      return {
        ...response,
        value: {
          ...concept,
          designSystem: {
            ...concept.designSystem,
            displayFontId: "unlisted-display-font",
            bodyFontId: "unlisted-body-font",
          },
        },
      };
    });

    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "Create an original product-first shop",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
    }, deps);

    expect(result.status).toBe("installed");
  });

  it("installs only content-addressed owned asset references and records their provenance", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "concept" && request.operation !== "repairConcept") return response;
      return {
        ...response,
        value: {
          ...(response.value as object),
          home: {
            ...(response.value as { home: object }).home,
            html: `<main><h1 data-cd-text="store.name"></h1><img data-cd-asset="hero" alt="Editorial hero"></main>`,
          },
          assetRequests: [{ key: "hero", purpose: "original editorial hero", required: true }],
        },
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
    expect(deps.cleanupAsset).not.toHaveBeenCalled();
  });

  it("garbage-collects partially persisted assets when materialization later fails", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "concept" && request.operation !== "repairConcept") return response;
      return {
        ...response,
        value: {
          ...(response.value as object),
          home: {
            ...(response.value as { home: object }).home,
            html: `<main><h1 data-cd-text="store.name"></h1><img data-cd-asset="hero" alt="Hero"><img data-cd-asset="detail" alt="Detail"></main>`,
          },
          assetRequests: [
            { key: "hero", purpose: "hero", required: true },
            { key: "detail", purpose: "detail", required: true },
          ],
        },
      };
    });
    deps.produceAsset = vi.fn(async ({ request }) => request.key === "hero"
      ? { bytes: new Uint8Array([1, 2, 3]), provenance: "fixture" }
      : null);
    deps.persistAsset = vi.fn(async () => ({ assetKey: "owned/sha256/hero.webp", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 3 }));

    const result = await generateOriginalStorefront({ shopId: TEST_SHOP_ID, prompt: "original", expectedDraftVersionId: null, actorId: null, trusted: true }, deps);
    expect(result.status).toBe("failed");
    expect(deps.cleanupAsset).toHaveBeenCalledTimes(1);
    expect(deps.cleanupAsset).toHaveBeenCalledWith(expect.objectContaining({ shopId: TEST_SHOP_ID, assetKey: "owned/sha256/hero.webp" }));
    expect(deps.installValidatedBundle).not.toHaveBeenCalled();
  });

  it("loads bounded reference bytes and sends them to concept calls under opaque keys", async () => {
    const context = createContext();
    context.referenceImages = [{ assetKey: "reference-image-001", mediaType: "image/webp" }];
    const deps = passingDependencies({
      assembleContext: vi.fn(async () => context),
      loadReferenceImages: vi.fn(async () => [{
        key: "reference-image-001",
        mediaType: "image/webp" as const,
        bytes: new Uint8Array([1, 2, 3]),
      }]),
    });
    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "original",
      referenceImages: [{ assetKey: "private/storage/reference.webp", mediaType: "image/webp" }],
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
    }, deps);
    expect(result.status).toBe("installed");
    const conceptRequests = vi.mocked(deps.provider.complete).mock.calls
      .map(([request]) => request)
      .filter((request) => request.operation === "concept");
    expect(conceptRequests).toHaveLength(3);
    expect(conceptRequests.every((request) => request.images?.[0]?.key === "reference-image-001")).toBe(true);
    expect(JSON.stringify(conceptRequests)).not.toContain("private/storage");
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

  it("meters all three concept renders into the browser budget before install", async () => {
    const renderConcept = vi.fn(async () => ({
      desktop: { key: "judge-desktop", mediaType: "image/webp" as const, bytes: new Uint8Array([1]) },
      mobile: { key: "judge-mobile", mediaType: "image/webp" as const, bytes: new Uint8Array([2]) },
      browserMs: 20,
    }));
    const deps = passingDependencies({ renderConcept });
    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "original",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
      budget: { maxBrowserMs: 59 },
    }, deps);

    expect(renderConcept).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "failed", code: "generation_budget_exceeded" });
    if (result.status !== "failed") throw new Error("expected browser budget failure");
    expect(result.audit?.usage?.browserMs).toBe(60);
    expect(deps.installValidatedBundle).not.toHaveBeenCalled();
  });

  it("actively aborts a hung provider call at the wall-time budget", async () => {
    const deps = passingDependencies({ now: () => Date.now() });
    deps.provider.complete = vi.fn((request) => new Promise<StructuredModelResponse>((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
    }));
    const generation = generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "original",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
      budget: { maxWallMs: 5 },
    }, deps);
    const result = await Promise.race([
      generation,
      new Promise<"test_timeout">((resolve) => setTimeout(() => resolve("test_timeout"), 100)),
    ]);

    expect(result).not.toBe("test_timeout");
    expect(result).toMatchObject({ status: "failed", code: "generation_budget_exceeded" });
    expect(deps.installValidatedBundle).not.toHaveBeenCalled();
  });

  it("races the wall-time abort through a browser adapter that ignores its signal", async () => {
    const deps = passingDependencies({
      now: () => Date.now(),
      browserProof: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const generation = generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "original",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
      budget: { maxWallMs: 5 },
    }, deps);
    const result = await Promise.race([
      generation,
      new Promise<"test_timeout">((resolve) => setTimeout(() => resolve("test_timeout"), 100)),
    ]);
    expect(result).not.toBe("test_timeout");
    expect(result).toMatchObject({ status: "failed", code: "generation_budget_exceeded" });
  });

  it("garbage-collects persisted candidate assets after a wall-time abort", async () => {
    const deps = passingDependencies({
      now: () => Date.now(),
      browserProof: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "concept" && request.operation !== "repairConcept") return response;
      return {
        ...response,
        value: {
          ...(response.value as object),
          home: { ...(response.value as { home: object }).home, html: `<main><h1 data-cd-text="store.name"></h1><img data-cd-asset="hero" alt="Hero"></main>` },
          assetRequests: [{ key: "hero", purpose: "hero", required: true }],
        },
      };
    });
    deps.produceAsset = vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), provenance: "fixture" }));
    deps.persistAsset = vi.fn(async () => ({ assetKey: "owned/sha256/hero.webp", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 3 }));
    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "original",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
      budget: { maxWallMs: 5 },
    }, deps);
    expect(result).toMatchObject({ status: "failed", code: "generation_budget_exceeded" });
    expect(deps.cleanupAsset).toHaveBeenCalledWith(expect.objectContaining({ assetKey: "owned/sha256/hero.webp" }));
  });

  it("has no import or call path to legacy generateStore", () => {
    const directory = resolve(process.cwd(), "app/lib/storefront-ai");
    const files = ["provider.server.ts", "concepts.server.ts", "expand.server.ts", "generate.server.ts"];
    const source = files.map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
    expect(source).not.toMatch(/storegen\/generate|\bgenerateStore\s*\(/);
  });
});
