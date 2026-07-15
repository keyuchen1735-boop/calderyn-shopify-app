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
      desktopCatalog: { key: "judge-desktop-catalog", mediaType: "image/webp" as const, bytes: new Uint8Array([2]) },
      mobile: { key: "judge-mobile", mediaType: "image/webp" as const, bytes: new Uint8Array([2]) },
      mobileCatalog: { key: "judge-mobile-catalog", mediaType: "image/webp" as const, bytes: new Uint8Array([3]) },
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
      const documentsSlotSyntax = request.system.includes("Trusted commerce hosts use data-cd-slot, never data-cd-trusted-slot-id") &&
        request.system.includes("Any other data-cd-*");
      const documentsMarkupGrammar = request.system.includes("Allowed HTML tags are") &&
        request.system.includes("Never emit <slot>") &&
        request.system.includes("Never emit <svg>") &&
        request.system.includes("Never set type on button") &&
        request.system.includes("Literal URL attributes") &&
        request.system.includes("data-cd-route");
      const expansion = structuredClone(response.value as ReturnType<typeof createExpansion>);
      if (!documentsSlotSyntax) {
        expansion.product.html = `<main><div data-cd-trusted-slot-id="product-slot">Choose</div></main>`;
      } else if (!documentsMarkupGrammar) {
        expansion.product.html = `<main><a href="/products/example">Product</a><button type="button">Choose</button><svg></svg><slot data-cd-slot="variantPicker"></slot></main>`;
      } else {
        return response;
      }
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

  it("installs when the provider follows the checkout CSS value contract", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "expand" || !request.prompt.includes("route group commerce")) return response;
      const documentsCheckoutValues = request.system.includes("grid tracks are only 1fr, 1fr 1fr, 2fr 1fr, or minmax(0, 1fr) minmax(0, 1fr)") &&
        request.system.includes("font-family is only inherit, var(--font-body), or var(--font-display)") &&
        request.system.includes("grid placement is one local identifier");
      if (documentsCheckoutValues) return response;
      const expansion = structuredClone(response.value as ReturnType<typeof createExpansion>);
      expansion.checkout.css = `main { display: grid; grid-template-columns: repeat(2, 1fr); font-family: sans-serif; grid-column: 1 / 2; }`;
      return { ...response, value: expansion };
    });

    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "Create an original shop",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
    }, deps);

    expect(result.status).toBe("installed");
  });

  it("installs expansion routes after removing inert HTML comments", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "expand") return response;
      const expansion = structuredClone(response.value as ReturnType<typeof createExpansion>);
      expansion.product.html = `<!-- product layout -->${expansion.product.html}`;
      expansion.product.rootScopeKind = "cart";
      expansion.checkout.html = `<!-- checkout layout -->${expansion.checkout.html}`;
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
    expect(result.bundle.routes.product.html).not.toContain("<!--");
  });

  it("rejects expansion HTML that is empty after comment removal", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "expand" || !request.prompt.includes("route group product")) return response;
      const expansion = structuredClone(response.value as ReturnType<typeof createExpansion>);
      expansion.product.html = "<!-- generated product -->";
      return { ...response, value: expansion };
    });

    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "Create an original shop",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
    }, deps);

    expect(result.status).toBe("failed");
  });

  it("installs when the provider follows the bounded concept source contract", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      if (request.operation !== "concept" && request.operation !== "repairConcept") return response;
      const schemaFields = (request.schema as {
        properties: {
          designSystem: { properties: {
          displayFontId: { enum?: readonly string[] };
          bodyFontId: { enum?: readonly string[] };
          motionStyle: { minLength?: number; maxLength?: number };
          breakpoints: { additionalProperties?: { type?: string; minimum?: number; maximum?: number } };
          } };
          assetRequests: { maxItems?: number; items?: { properties?: { key?: { pattern?: string } } } };
        };
      }).properties;
      const fontFields = schemaFields.designSystem.properties;
      const expectedFontIds = JSON.stringify(CURATED_FONT_IDS);
      const constrainsFonts = JSON.stringify(fontFields.displayFontId.enum) === expectedFontIds &&
        JSON.stringify(fontFields.bodyFontId.enum) === expectedFontIds;
      const constrainsMotionStyle = fontFields.motionStyle.minLength === 1 && fontFields.motionStyle.maxLength === 120;
      const constrainsBreakpoints = fontFields.breakpoints.additionalProperties?.type === "number" &&
        fontFields.breakpoints.additionalProperties.minimum === 240 &&
        fontFields.breakpoints.additionalProperties.maximum === 3_840;
      const boundsAssets = schemaFields.assetRequests.maxItems === 8;
      const constrainsAssetKeys = schemaFields.assetRequests.items?.properties?.key?.pattern === "^[A-Za-z0-9_-]{1,80}$";
      const documentsAssetRules = request.system.includes("at most 8 asset requests") &&
        request.system.includes("^[A-Za-z0-9_-]{1,80}$");
      const documentsDescriptions = request.system.includes("iconStyle and motionStyle must be non-empty");
      const documentsBreakpoints = request.system.includes("Breakpoint values must be JSON numbers from 240 through 3840");
      const documentsInteractionGrammar = request.system.includes("Allowed data-cd-on events are") &&
        request.system.includes("Allowed data-cd-action values are") &&
        request.system.includes("collection.filter") &&
        request.system.includes("Do not invent interaction actions");
      const documentsBindingGrammar = request.system.includes("Allowed data-cd-text paths are") &&
        request.system.includes("store.name") && request.system.includes("product.price") &&
        request.system.includes("collection.products") && request.system.includes("product.variants");
      const documentsPathValueGrammar = request.system.includes("Path-valued data-cd attributes never contain literal record values") &&
        request.system.includes("data-cd-product uses only product.id");
      const documentsRouteGrammar = request.system.includes("Allowed data-cd-route values are home") &&
        request.system.includes("never URL paths") &&
        request.system.includes("Every product or collection route target requires data-cd-param-handle") &&
        request.system.includes("Every policy route target requires data-cd-param-policy-id");
      const forbidsInlineStyles = request.system.includes("inline style attributes") &&
        request.system.includes("Every element must omit the style attribute; put all declarations in CSS");
      const documentsOutputOnlyHooks = request.system.includes("data-cd-active-value and data-cd-class-token are compiler output hooks");
      const documentsRouteAnchorGrammar = request.system.includes("Never emit href; every anchor uses data-cd-route");
      const documentsScopedParams = request.system.includes("At shell/home root scope, never use data-cd-param-handle") &&
        request.system.includes("Inside a product repeat, product links require data-cd-param-handle=\"product.handle\"") &&
        request.system.includes("Root catalog links use search, never parameterless product or collection routes");
      const forbidsFixedLayout = request.system.includes("Any position: fixed declaration fails compilation");
      const constrainsConceptStage = request.prompt.includes("Concept shell/home are static compiler-safe previews") &&
        request.prompt.includes("Product bindings appear only inside a featured.products repeat") &&
        request.prompt.includes("Root anchors use no route parameters and never target product or collection") &&
        request.prompt.includes("Product anchors inside featured.products require data-cd-param-handle=\"product.handle\"") &&
        request.prompt.includes("The repeat parent has only data-cd-repeat") &&
        request.prompt.includes('set data-cd-repeat="featured.products" on it');
      const documentsRepeatAttributePairs = request.system.includes("Allowed data-cd-repeat values are collection.products, featured.products") &&
        request.system.includes('For featured.products, set data-cd-repeat="featured.products" on the parent and data-cd-key="product.id" on a descendant');
      const documentsClosedCompilerGrammar = request.system.includes("Allowed CSS at-rules are") &&
        request.system.includes("Every local ID reference") &&
        request.system.includes("data-cd-key on a descendant") &&
        request.system.includes("Allowed data-cd-slot values are variantPicker") &&
        request.system.includes("Checkout is decorative only");
      if (constrainsFonts && constrainsMotionStyle && constrainsBreakpoints && boundsAssets && constrainsAssetKeys && documentsAssetRules && documentsDescriptions && documentsBreakpoints && documentsInteractionGrammar && documentsBindingGrammar && documentsPathValueGrammar && documentsRouteGrammar && forbidsInlineStyles && documentsOutputOnlyHooks && documentsRouteAnchorGrammar && documentsScopedParams && forbidsFixedLayout && documentsClosedCompilerGrammar && documentsRepeatAttributePairs && constrainsConceptStage) return response;
      const concept = structuredClone(response.value as ReturnType<typeof createConcept>);
      return {
        ...response,
        value: {
          ...concept,
          designSystem: {
            ...concept.designSystem,
            ...(constrainsFonts ? {} : {
              displayFontId: "unlisted-display-font",
              bodyFontId: "unlisted-body-font",
            }),
            ...((constrainsMotionStyle && documentsDescriptions) ? {} : { motionStyle: "" }),
            ...((constrainsBreakpoints && documentsBreakpoints) ? {} : { breakpoints: { mobile: 40 } }),
          },
          home: !documentsInteractionGrammar
              ? { ...concept.home, html: `<main><button id="zone" data-cd-on="click" data-cd-action="filterZone">Filter zone</button></main>` }
              : !documentsBindingGrammar
                ? { ...concept.home, html: `<main><span data-cd-text="apparel"></span></main>` }
                : !documentsPathValueGrammar
                  ? { ...concept.home, html: `<main><span data-cd-text="home-page"></span></main>` }
                  : !documentsRouteGrammar
                  ? { ...concept.home, html: `<main><a data-cd-route="/">Home</a></main>` }
                  : !forbidsInlineStyles
                    ? { ...concept.home, html: `<main style="display:grid"><p>Store</p></main>` }
                    : !documentsOutputOnlyHooks
                      ? { ...concept.home, html: `<main><span data-cd-active-value="gear">Gear</span></main>` }
                      : !documentsRouteAnchorGrammar
                        ? { ...concept.home, html: `<main><a href="#home" data-cd-route="home">Home</a></main>` }
                        : !documentsScopedParams
                          ? { ...concept.home, html: `<main><a data-cd-route="collection" data-cd-param-handle="collection.handle">Catalog</a></main>` }
                          : !forbidsFixedLayout
                            ? { ...concept.home, css: `${concept.home.css}\n.dock { position: fixed; }` }
                            : !documentsClosedCompilerGrammar
                              ? { ...concept.home, html: `<main><a href="#home">Home</a></main>` }
                              : !documentsRepeatAttributePairs
                                ? { ...concept.home, html: `<main><div data-cd-repeat="featured.products/product.id"><article data-cd-key="product.id"><span data-cd-text="product.title"></span></article></div></main>` }
                              : !constrainsConceptStage
                                ? { ...concept.home, html: `<main><button data-cd-on="click" data-cd-action="scroll.to" data-cd-target="other-route">Explore</button></main>` }
                                : concept.home,
          assetRequests: boundsAssets && documentsAssetRules
            ? [{ key: constrainsAssetKeys ? "hero" : "asset.hero", purpose: "Generated asset", required: false }]
            : Array.from({ length: 9 }, (_, index) => ({
              key: `asset-${index}`,
              purpose: `Generated asset ${index}`,
              required: false,
            })),
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

  it("allows the production-sized concept, judging, and expansion path within the default model budget", async () => {
    const deps = passingDependencies();
    const baseComplete = deps.provider.complete;
    deps.provider.complete = vi.fn(async (request) => {
      const response = await baseComplete(request);
      const modelTokens = request.operation === "judge" ? 20_000
        : request.operation === "expand" ? 15_943
          : 18_000;
      return { ...response, usage: { inputTokens: modelTokens, outputTokens: 0 } };
    });

    const result = await generateOriginalStorefront({
      shopId: TEST_SHOP_ID,
      prompt: "original",
      expectedDraftVersionId: null,
      actorId: null,
      trusted: true,
    }, deps);

    expect(result.status).toBe("installed");
    if (result.status !== "installed") throw new Error("expected install");
    expect(result.audit.usage.modelTokens).toBe(197_829);
    expect(deps.installValidatedBundle).toHaveBeenCalledOnce();
  });

  it("meters all three concept renders into the browser budget before install", async () => {
    const renderConcept = vi.fn(async () => ({
      desktop: { key: "judge-desktop", mediaType: "image/webp" as const, bytes: new Uint8Array([1]) },
      desktopCatalog: { key: "judge-desktop-catalog", mediaType: "image/webp" as const, bytes: new Uint8Array([2]) },
      mobile: { key: "judge-mobile", mediaType: "image/webp" as const, bytes: new Uint8Array([2]) },
      mobileCatalog: { key: "judge-mobile-catalog", mediaType: "image/webp" as const, bytes: new Uint8Array([3]) },
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
    vi.useFakeTimers();
    try {
      let proofStarted!: () => void;
      const atProof = new Promise<void>((resolve) => { proofStarted = resolve; });
      const deps = passingDependencies({
        now: () => Date.now(),
        browserProof: vi.fn(() => {
          proofStarted();
          return new Promise<never>(() => undefined);
        }),
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
      const generation = generateOriginalStorefront({
        shopId: TEST_SHOP_ID,
        prompt: "original",
        expectedDraftVersionId: null,
        actorId: null,
        trusted: true,
        budget: { maxWallMs: 5 },
      }, deps);
      await atProof;
      expect(deps.persistAsset).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5);
      const result = await generation;
      expect(result).toMatchObject({ status: "failed", code: "generation_budget_exceeded" });
      expect(deps.cleanupAsset).toHaveBeenCalledWith(expect.objectContaining({ assetKey: "owned/sha256/hero.webp" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no import or call path to legacy generateStore", () => {
    const directory = resolve(process.cwd(), "app/lib/storefront-ai");
    const files = ["provider.server.ts", "concepts.server.ts", "expand.server.ts", "generate.server.ts"];
    const source = files.map((file) => readFileSync(resolve(directory, file), "utf8")).join("\n");
    expect(source).not.toMatch(/storegen\/generate|\bgenerateStore\s*\(/);
  });
});
