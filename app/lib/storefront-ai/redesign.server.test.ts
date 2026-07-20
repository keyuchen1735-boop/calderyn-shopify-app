import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserProofReport } from "./contracts";
import type { RouteSource, StorefrontBundleSourceV1 } from "../storefront-compiler/compile";
import { CUSTOM_BENCH_RECIPE } from "../storefront-recipes/custom-bench/bundle";
import { recipeCompilerSource } from "../storefront-recipes/factory";
import type { StorefrontContextAssembly } from "./context.server";
import type { StorefrontVersionArtifactV1 } from "./authoring.server";
import {
  redesignGroupPrompt,
  redesignPlanPrompt,
  redesignRepairPrompt,
  storefrontRedesignRepairSystemPrompt,
  storefrontRedesignSystemPrompt,
  STOREFRONT_COMPILER_SOURCE_CONTRACT,
  structuralRedesignPrompt,
} from "./redesign-prompts.server";
import { completeRedesignRequest } from "./redesign-provider.server";
import type { RedesignProviderRequest, RedesignProviderResult } from "./redesign-provider.server";
import {
  REDESIGN_GROUP_SCHEMAS,
  REDESIGN_OUTPUT_CODE_POINT_CAP,
  REDESIGN_OUTPUT_BYTE_CAP,
  parseRedesignGroup,
  parseRedesignJson,
  parseRedesignRepairRequest,
  parseStorefrontDesignPlan,
  parseStructuralRouteResponse,
  type StorefrontDesignPlan,
} from "./redesign-schema.server";
import {
  runStorefrontRedesign,
  type RunStorefrontRedesignInput,
  type StorefrontRedesignDependencies,
} from "./redesign.server";

const { createMessage } = vi.hoisted(() => ({ createMessage: vi.fn() }));

vi.mock("../assistant/anthropic.server", () => ({
  assistantModel: () => "test-model",
  getAnthropic: () => ({ messages: { create: createMessage } }),
}));

function route(html = "<main></main>"): RouteSource {
  return { html, css: "", requiredData: [], requiredCapabilities: [] };
}

function plan(): StorefrontDesignPlan {
  return {
    concept: { name: "Workshop", rationale: "A useful storefront.", noveltySignature: ["indexed catalog"] },
    designSystem: {
      displayFontId: "syne",
      bodyFontId: "inter",
      tokens: { ink: "#111111" },
      breakpoints: { wide: 960 },
      iconStyle: "outlined",
      motionStyle: "restrained",
      globalCss: "",
    },
    routeBriefs: {
      shell: "Persistent utility frame.", home: "Narrative entry.", collection: "Catalog index.",
      product: "Media and purchase split.", search: "Query workspace.", cart: "Line ledger.", checkout: "Trust frame.",
    },
  };
}

const providerAudit = { provider: "anthropic", model: "test-model", inputTokens: 1, outputTokens: 1 } as const;

function context(): StorefrontContextAssembly {
  return {
    context: {
      version: 1, prompt: "Redesign", promptHash: "sha256:opaque", referenceImages: [],
      store: { name: "Store", logoAssetKey: null, publicBrandAssetKeys: [] }, collections: [],
      products: [{
        id: "product-001", handle: "item", title: "Item", productType: null, tags: [], optionNames: [],
        priceMin: 10, priceMax: 10, currency: "USD", availability: "available", images: [],
      }],
      reusableAssets: [], recipeNoveltySignatures: [], fingerprint: "sha256:context",
    },
    references: {
      products: { "product-001": { id: "owned-product-id", handle: "item" } },
      collections: {}, assets: {},
    },
  };
}

function baseArtifact(): StorefrontVersionArtifactV1 {
  return { sourceKind: "recipe", bundle: structuredClone(CUSTOM_BENCH_RECIPE.bundle) };
}

function input(mode: RunStorefrontRedesignInput["mode"]): RunStorefrontRedesignInput {
  return {
    shopId: "shop-1", prompt: "Redesign", mode,
    ...(mode === "structural_edit" ? { scope: { routeId: "product" as const } } : {}),
    baseVersionId: "version-1", baseArtifact: baseArtifact(), recipe: CUSTOM_BENCH_RECIPE,
    context: context(), referenceImages: [],
  };
}

function sourcePlan(source: StorefrontBundleSourceV1): StorefrontDesignPlan {
  return {
    concept: structuredClone(source.concept), designSystem: structuredClone(source.designSystem),
    routeBriefs: {
      shell: "Shell", home: "Home", collection: "Collection", product: "Product",
      search: "Search", cart: "Cart", checkout: "Checkout",
    },
  };
}

function fakeComplete(respond: (request: RedesignProviderRequest<unknown>) => unknown): typeof completeRedesignRequest {
  return (async <T>(request: RedesignProviderRequest<T>): Promise<RedesignProviderResult<T>> => ({
    value: request.parse(respond(request as RedesignProviderRequest<unknown>)), audit: providerAudit,
  })) as typeof completeRedesignRequest;
}

function passingProof(): BrowserProofReport {
  return { ok: true, diagnostics: [], screenshots: [], browserMs: 1 };
}

describe("storefront redesign structured boundary", () => {
  beforeEach(() => createMessage.mockReset());

  it("accepts an exact bounded design plan and rejects non-curated fonts", () => {
    expect(parseStorefrontDesignPlan(plan())).toEqual(plan());
    expect(() => parseStorefrontDesignPlan({
      ...plan(),
      designSystem: { ...plan().designSystem, displayFontId: "https://fonts.example/font.woff2" },
    })).toThrow("Invalid storefront redesign response");
    expect(() => parseStorefrontDesignPlan({ ...plan(), commentary: "extra" })).toThrow();
  });

  it("requires the exact structural route and group keys", () => {
    expect(parseStructuralRouteResponse({ routeId: "product", route: route() }, "product")).toEqual({ routeId: "product", route: route() });
    expect(() => parseStructuralRouteResponse({ routeId: "product", route: route(), prose: "done" }, "product")).toThrow();
    expect(() => parseRedesignGroup({ group: "catalog", collection: route(), product: route() }, "catalog")).toThrow();
    expect(() => parseRedesignGroup({ group: "commerce", cart: route(), checkout: { html: "<main></main>", css: "", layout: {} }, extra: route() }, "commerce")).toThrow();
  });

  it("rejects prose-wrapped JSON and oversized output before parsing", () => {
    expect(() => parseRedesignJson(`Here you go: ${JSON.stringify(plan())}`, parseStorefrontDesignPlan)).toThrow();
    expect(() => parseRedesignJson("x".repeat(REDESIGN_OUTPUT_CODE_POINT_CAP + 1), parseStorefrontDesignPlan)).toThrow();
    expect(Buffer.byteLength("😀".repeat(Math.floor(REDESIGN_OUTPUT_BYTE_CAP / 4) + 1), "utf8")).toBeGreaterThan(REDESIGN_OUTPUT_BYTE_CAP);
    expect(() => parseRedesignJson("😀".repeat(Math.floor(REDESIGN_OUTPUT_BYTE_CAP / 4) + 1), parseStorefrontDesignPlan)).toThrow();
  });

  it("requires exact repair request keys", () => {
    const repair = { routeId: "product", route: route(), diagnostics: [{ code: "slot.missing", message: "Restore add-to-cart." }] };
    expect(parseRedesignRepairRequest(repair)).toEqual(repair);
    expect(() => parseRedesignRepairRequest({ ...repair, unrelatedRoute: route() })).toThrow();
  });

  it("composes server-only design guidance with compiler and trust contracts", () => {
    const prompt = storefrontRedesignSystemPrompt();
    expect(prompt).toContain("Every element must earn its place");
    expect(prompt).toContain("No scripts, event handlers, imports, network URLs");
    expect(prompt).toContain("Preserve platform-owned commerce slots");
    for (const syntax of ["data-cd-text", "product.title", "state.set", "data-cd-route", "quickViewCommerce", "syne"]) {
      expect(prompt).toContain(syntax);
    }
    const repair = storefrontRedesignRepairSystemPrompt();
    expect(repair).toContain("Report only concrete, source-grounded defects");
    expect(repair).toContain("smallest scoped repair");
    expect(STOREFRONT_COMPILER_SOURCE_CONTRACT.stateDeclarations).toMatchObject({
      types: ["boolean", "enum", "boundedNumber", "index", "textQuery"],
      enumAllowedValues: { attribute: "data-cd-state-values", minimum: 2, maximum: 32, maximumCodeUnitsPerValue: 40 },
    });
    expect(STOREFRONT_COMPILER_SOURCE_CONTRACT.stateBindings.properties).toEqual([
      "hidden", "expanded", "selected", "activeIndex", "textQuery", "classToken", "progress01",
    ]);
    expect(STOREFRONT_COMPILER_SOURCE_CONTRACT.trustedSlotFields).toMatchObject({
      hostTags: ["div", "section", "aside", "span"],
      hostSizes: ["inline", "block", "panel", "page"],
      product: { attribute: "data-cd-product", rule: "visible public binding path" },
    });
    expect(STOREFRONT_COMPILER_SOURCE_CONTRACT.interactions.valueFields).toEqual(["value", "checked", "key", "progress01"]);
    expect(STOREFRONT_COMPILER_SOURCE_CONTRACT.platformAttributes).toEqual({
      policyLinks: { attribute: "data-cd-policy-links", shellPlacement: "inside footer" },
      emptyState: { attribute: "data-cd-empty-state", valueless: true },
      nativeControl: { attribute: "data-cd-native-control" },
    });
  });

  it("sends opaque context but never owned reference mappings in any prompt", () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const context: StorefrontContextAssembly = {
      context: {
        version: 1, prompt: "Redesign", promptHash: "sha256:opaque", referenceImages: [],
        store: { name: "Store", logoAssetKey: "brand-asset-001", publicBrandAssetKeys: [] },
        collections: [], products: [], reusableAssets: [], recipeNoveltySignatures: [], fingerprint: "sha256:context",
      },
      references: {
        products: { "product-001": { id: "owned-product-id", handle: "owned-product-handle" } },
        collections: { "collection-001": { id: "owned-collection-id", handle: "owned-collection-handle" } },
        assets: { "brand-asset-001": "owned/storage/asset-key" },
      },
    };
    const repair = { routeId: "product" as const, route: source.routes.product, diagnostics: [{ code: "x", message: "fix" }] };
    const prompts = [
      structuralRedesignPrompt({ prompt: "Redesign", routeId: "product", targetRoute: source.routes.product, source, context }),
      redesignPlanPrompt({ prompt: "Redesign", source, context }),
      redesignGroupPrompt({ prompt: "Redesign", group: "catalog", plan: plan(), source, context }),
      redesignRepairPrompt({ prompt: "Redesign", designSystem: source.designSystem, repair, context }),
    ];
    expect(prompts.map((prompt) => JSON.parse(prompt).operation)).toEqual([
      "structural_route", "full_redesign_plan", "full_redesign_group", "repair_route",
    ]);
    for (const prompt of prompts) {
      expect(JSON.parse(prompt)).toMatchObject({ compilerId: "schema-1/runtime-1/validation-1", merchantContext: context.context });
      expect(JSON.parse(prompt)).not.toHaveProperty("ownedReferences");
      expect(prompt).toContain("brand-asset-001");
      for (const secret of ["owned-product-id", "owned-product-handle", "owned-collection-id", "owned-collection-handle", "owned/storage/asset-key"]) {
        expect(prompt).not.toContain(secret);
      }
    }
  });

  it("sends verified images plus exactly one text block and returns provider audit", async () => {
    const signal = new AbortController().signal;
    createMessage.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ group: "shell_home", shell: route(), home: route() }) }],
      usage: { input_tokens: 21, output_tokens: 34 },
    });

    const result = await completeRedesignRequest({
      system: "system",
      prompt: "prompt",
      schema: REDESIGN_GROUP_SCHEMAS.shell_home,
      parse: (value) => parseRedesignGroup(value, "shell_home"),
      maxTokens: 24_000,
      referenceImages: [{ url: "https://assets.example/reference.webp", mediaType: "image/webp" }],
      signal,
    });

    expect(result.audit).toEqual({ provider: "anthropic", model: "test-model", inputTokens: 21, outputTokens: 34 });
    const [request, options] = createMessage.mock.calls[0];
    expect(request.messages[0].content.filter((block: { type: string }) => block.type === "text")).toEqual([{ type: "text", text: "prompt" }]);
    expect(options.signal).toBe(signal);
  });

  it("rejects unverified image URLs and non-text provider output", async () => {
    const request = {
      system: "system",
      prompt: "prompt",
      schema: REDESIGN_GROUP_SCHEMAS.shell_home,
      parse: (value: unknown) => parseRedesignGroup(value, "shell_home"),
      maxTokens: 24_000,
    };
    await expect(completeRedesignRequest({
      ...request,
      referenceImages: [{ url: "http://assets.example/reference.webp", mediaType: "image/webp" }],
    })).rejects.toThrow("Invalid storefront redesign provider response");

    createMessage.mockResolvedValue({ content: [{ type: "tool_use" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(completeRedesignRequest(request)).rejects.toThrow("Invalid storefront redesign provider response");
  });
});

describe("storefront redesign orchestration", () => {
  it("changes only the scoped route, preserves the base source, and proves with owned product IDs", async () => {
    const baseSource = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const snapshot = structuredClone(baseSource);
    const product = {
      ...baseSource.routes.product,
      html: baseSource.routes.product.html.replace("Workshop work order", "Custom workshop work order"),
    };
    const prove = vi.fn(async (_input: { context: StorefrontContextAssembly["context"] }) => passingProof());

    const result = await runStorefrontRedesign(input("structural_edit"), {
      complete: fakeComplete(() => ({ routeId: "product", route: product })), prove,
      generationId: () => "generation-1",
    });

    expect(result.artifact.authoring!.source.routes.product).toEqual(product);
    expect(result.artifact.authoring!.source.routes.home).toEqual(baseSource.routes.home);
    expect(result.artifact.authoring!.source).not.toBe(baseSource);
    expect(baseSource).toEqual(snapshot);
    expect(result.artifact.bundle.source).toMatchObject({
      kind: "custom", generationId: "generation-1", derivedFromVersionId: "version-1",
      derivedFromTemplateId: "custom-bench",
    });
    expect(prove.mock.calls[0]![0].context.products[0]!.id).toBe("owned-product-id");
  });

  it("freezes the plan, assembles exact full-redesign groups, and keeps only referenced allowlisted assets", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const nextPlan = sourcePlan(source);
    const operations: string[] = [];
    const complete = fakeComplete((request) => {
      const body = JSON.parse(request.prompt) as { operation: string; group?: string; frozenPlan?: unknown };
      operations.push(body.operation + (body.group ? `:${body.group}` : ""));
      if (body.operation === "full_redesign_plan") return nextPlan;
      expect(body.frozenPlan).toEqual(nextPlan);
      if (body.group === "shell_home") return {
        group: "shell_home", shell: source.shell,
        home: { ...source.routes.home, html: source.routes.home.html.replaceAll(' data-cd-asset="hero"', "") },
      };
      if (body.group === "catalog") return {
        group: "catalog", collection: source.routes.collection, product: source.routes.product, search: source.routes.search,
      };
      return { group: "commerce", cart: source.routes.cart, checkout: source.routes.checkout };
    });

    const result = await runStorefrontRedesign(input("full_redesign"), {
      complete, prove: async () => passingProof(), generationId: () => "generation-2",
    });

    expect(operations).toEqual([
      "full_redesign_plan", "full_redesign_group:shell_home", "full_redesign_group:catalog", "full_redesign_group:commerce",
    ]);
    expect(result.artifact.authoring!.source.assets.entries).toEqual([]);
    expect(result.audit.changedRouteIds).toEqual(["home"]);
    expect(result.audit.shellChanged).toBe(false);
  });

  it("recomputes the allowlisted asset subset after a route repair", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    source.shell.html = source.shell.html.replaceAll(' data-cd-asset="hero"', "");
    for (const routeId of ["home", "collection", "product", "search", "cart"] as const) {
      source.routes[routeId].html = source.routes[routeId].html.replaceAll(' data-cd-asset="hero"', "");
    }
    const customInput = { ...input("structural_edit"), baseArtifact: { sourceKind: "custom" as const, bundle: CUSTOM_BENCH_RECIPE.bundle, authoring: { version: 1 as const, source, overrides: {} } } };
    let calls = 0;
    const complete = fakeComplete(() => {
      calls += 1;
      return calls === 1
        ? { routeId: "product", route: { ...source.routes.product, html: source.routes.product.html + '<img data-cd-asset="hero">' } }
        : { routeId: "product", route: source.routes.product };
    });
    const prove = vi.fn(async () => prove.mock.calls.length === 1
      ? { ok: false, diagnostics: [{ routeId: "product" as const, code: "layout", message: "repair" }], screenshots: [], browserMs: 1 }
      : passingProof());
    const result = await runStorefrontRedesign(customInput, { complete, prove });
    expect(result.artifact.authoring.source.assets.entries).toEqual([]);
  });

  it("retains allowlisted assets referenced with valid unquoted HTML attributes", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const product = { ...source.routes.product, html: `${source.routes.product.html}<img data-cd-asset=hero alt="Workshop">` };
    const result = await runStorefrontRedesign(input("structural_edit"), {
      complete: fakeComplete(() => ({ routeId: "product", route: product })),
      prove: async () => passingProof(),
    });
    expect(result.artifact.authoring.source.assets.entries.map(({ key }) => key)).toContain("hero");
  });

  it("reports semantic route equality independent of object key insertion order", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const product = source.routes.product;
    source.routes.product = {
      requiredCapabilities: product.requiredCapabilities,
      requiredData: product.requiredData,
      css: product.css,
      html: product.html,
      ...(product.rootScopeKind ? { rootScopeKind: product.rootScopeKind } : {}),
    };
    const customInput = {
      ...input("structural_edit"),
      baseArtifact: { sourceKind: "custom" as const, bundle: CUSTOM_BENCH_RECIPE.bundle, authoring: { version: 1 as const, source, overrides: {} } },
    };
    const result = await runStorefrontRedesign(customInput, {
      complete: fakeComplete(() => ({ routeId: "product", route: structuredClone(product) })),
      prove: async () => passingProof(),
    });
    expect(result.audit.changedRouteIds).toEqual([]);
  });

  it("fails closed when owned proof references are missing", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const missing = input("structural_edit");
    missing.context.references.products = {};
    await expect(runStorefrontRedesign(missing, {
      complete: fakeComplete(() => ({ routeId: "product", route: source.routes.product })),
      prove: async () => passingProof(),
    })).rejects.toMatchObject({ code: "storefront_redesign_context_invalid" });
  });

  it("fails closed for shell and global diagnostics without spending route repairs", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const completeSpy = vi.fn(fakeComplete(() => ({ routeId: "product", route: source.routes.product })));
    const complete = completeSpy as unknown as typeof completeRedesignRequest;
    const compile: StorefrontRedesignDependencies["compile"] = () => ({
      bundle: CUSTOM_BENCH_RECIPE.bundle, hash: "hash",
      report: { profileVersion: 1, ok: false, diagnostics: [{ code: "design.token", path: "designSystem.globalCss", message: "global failure" }] },
    });
    await expect(runStorefrontRedesign(input("structural_edit"), { complete, compile, prove: async () => passingProof() }))
      .rejects.toMatchObject({ code: "storefront_redesign_compile_failed" });
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("bounds compile diagnostics before a route repair prompt", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const prompts: string[] = [];
    const complete = fakeComplete((request) => {
      prompts.push(request.prompt);
      return { routeId: "product", route: source.routes.product };
    });
    let compileCalls = 0;
    const compile: StorefrontRedesignDependencies["compile"] = () => {
      compileCalls += 1;
      if (compileCalls === 1) {
        throw Object.assign(new Error("m".repeat(2_000)), { code: "x".repeat(200), path: "routes.product" });
      }
      return { bundle: CUSTOM_BENCH_RECIPE.bundle, hash: "hash", report: { profileVersion: 1, ok: true, diagnostics: [] } };
    };
    await runStorefrontRedesign(input("structural_edit"), { complete, compile, validate: () => ({ profileVersion: 1, ok: true, diagnostics: [] }), prove: async () => passingProof() });
    const repair = JSON.parse(prompts[1]!) as { diagnostics: Array<{ code: string; message: string }> };
    expect(repair.diagnostics[0]).toMatchObject({ code: "x".repeat(120), message: "m".repeat(1_000) });
  });

  it("uses the real compiler to repair removal of a required commerce slot", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const withoutSlot = { ...source.routes.product, html: source.routes.product.html.replace(/<div[^>]+data-cd-slot="addToCart"[^>]*><\/div>/, "") };
    let calls = 0;
    const result = await runStorefrontRedesign(input("structural_edit"), {
      complete: fakeComplete(() => ({ routeId: "product", route: ++calls === 1 ? withoutSlot : source.routes.product })),
      prove: async () => passingProof(),
    });
    expect(calls).toBe(2);
    expect(result.audit.repairs).toBe(1);
  });

  it.each([
    ["script", (source: StorefrontBundleSourceV1) => ({ ...source.routes.product, html: "<main><script></script></main>" })],
    ["remote URL", (source: StorefrontBundleSourceV1) => ({ ...source.routes.product, html: '<main><img src="https://example.com/x.jpg" alt="x"></main>' })],
    ["invalid CSS", (source: StorefrontBundleSourceV1) => ({ ...source.routes.product, css: "@import url(https://example.com/x.css)" })],
  ])("repairs a route-local real compiler exception: %s", async (_label, invalidRoute) => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    let calls = 0;
    const result = await runStorefrontRedesign(input("structural_edit"), {
      complete: fakeComplete(() => ({ routeId: "product", route: ++calls === 1 ? invalidRoute(source) : source.routes.product })),
      prove: async () => passingProof(), generationId: () => "generation-repaired",
    });
    expect(result.audit.repairs).toBe(1);
    expect(calls).toBe(2);
  });

  it("rejects unknown assets and invalid validation reports", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    await expect(runStorefrontRedesign(input("structural_edit"), {
      complete: fakeComplete(() => ({ routeId: "product", route: { ...source.routes.product, html: '<main><img data-cd-asset="invented" alt="x"></main>' } })),
      prove: async () => passingProof(), generationId: () => "generation-invalid",
    })).rejects.toMatchObject({ code: "storefront_redesign_asset_invalid" });

    const compile: StorefrontRedesignDependencies["compile"] = () => ({
      bundle: CUSTOM_BENCH_RECIPE.bundle, hash: "hash",
      report: { profileVersion: 1, ok: false, diagnostics: [{ code: "slot.missing", path: "routes.product", message: "Missing trusted commerce slot" }] },
    });
    await expect(runStorefrontRedesign(input("structural_edit"), {
      complete: fakeComplete(() => ({ routeId: "product", route: source.routes.product })),
      compile, prove: async () => passingProof(), generationId: () => "generation-invalid",
    })).rejects.toMatchObject({ code: "storefront_redesign_compile_failed" });
  });

  it("attributes full-redesign compiler exceptions only after shell/design preflight", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    let repairCalls = 0;
    const complete = fakeComplete((request) => {
      const body = JSON.parse(request.prompt) as { operation: string; group?: string; routeId?: string };
      if (body.operation === "full_redesign_plan") return sourcePlan(source);
      if (body.operation === "repair_route") {
        repairCalls += 1;
        return { routeId: body.routeId, route: source.routes.product };
      }
      if (body.group === "shell_home") return { group: "shell_home", shell: source.shell, home: source.routes.home };
      if (body.group === "catalog") return {
        group: "catalog", collection: source.routes.collection,
        product: { ...source.routes.product, html: "<main><script></script></main>" }, search: source.routes.search,
      };
      return { group: "commerce", cart: source.routes.cart, checkout: source.routes.checkout };
    });
    const result = await runStorefrontRedesign(input("full_redesign"), { complete, prove: async () => passingProof() });
    expect(result.audit.repairs).toBe(1);
    expect(repairCalls).toBe(1);
  });

  it("fails closed when real full-redesign shell/design preflight compilation fails", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    let repairCalls = 0;
    const complete = fakeComplete((request) => {
      const body = JSON.parse(request.prompt) as { operation: string; group?: string };
      if (body.operation === "full_redesign_plan") {
        const nextPlan = sourcePlan(source);
        nextPlan.designSystem.globalCss = "@import url(https://example.com/global.css)";
        return nextPlan;
      }
      if (body.operation === "repair_route") repairCalls += 1;
      if (body.group === "shell_home") return { group: "shell_home", shell: source.shell, home: source.routes.home };
      if (body.group === "catalog") return { group: "catalog", collection: source.routes.collection, product: source.routes.product, search: source.routes.search };
      return { group: "commerce", cart: source.routes.cart, checkout: source.routes.checkout };
    });
    await expect(runStorefrontRedesign(input("full_redesign"), { complete, prove: async () => passingProof() }))
      .rejects.toMatchObject({ code: "storefront_redesign_compile_failed" });
    expect(repairCalls).toBe(0);
  });

  it("allows at most two full-redesign repairs and exposes no partial artifact when proof still fails", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    let repairCalls = 0;
    const complete = fakeComplete((request) => {
      const body = JSON.parse(request.prompt) as { operation: string; group?: string; routeId?: string };
      if (body.operation === "full_redesign_plan") return sourcePlan(source);
      if (body.operation === "repair_route") {
        repairCalls += 1;
        return { routeId: body.routeId, route: source.routes[body.routeId as keyof typeof source.routes] };
      }
      if (body.group === "shell_home") return { group: "shell_home", shell: source.shell, home: source.routes.home };
      if (body.group === "catalog") return { group: "catalog", collection: source.routes.collection, product: source.routes.product, search: source.routes.search };
      return { group: "commerce", cart: source.routes.cart, checkout: source.routes.checkout };
    });
    const prove = vi.fn(async () => ({
      ok: false, screenshots: [], browserMs: 1,
      diagnostics: [
        { routeId: "home" as const, code: "layout.home", message: "x".repeat(2_000) },
        { routeId: "product" as const, code: "layout.product", message: "Product failed" },
        { routeId: "cart" as const, code: "layout.cart", message: "Cart failed" },
      ],
    }));

    await expect(runStorefrontRedesign(input("full_redesign"), {
      complete, prove, generationId: () => "generation-3",
    })).rejects.toMatchObject({ code: "storefront_redesign_proof_failed" });
    expect(repairCalls).toBe(2);
    expect(prove).toHaveBeenCalledTimes(3);
  });

  it("forwards cancellation and enforces the 10-minute operation and 180-second proof deadlines", async () => {
    const source = recipeCompilerSource(CUSTOM_BENCH_RECIPE);
    const aborted = new AbortController();
    aborted.abort();
    await expect(runStorefrontRedesign({ ...input("structural_edit"), signal: aborted.signal }, {
      complete: fakeComplete(() => ({ routeId: "product", route: source.routes.product })),
      prove: async () => passingProof(),
    })).rejects.toMatchObject({ code: "storefront_redesign_cancelled" });

    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      const pending = runStorefrontRedesign(input("structural_edit"), {
        complete: (async (request: RedesignProviderRequest<unknown>) => {
          providerSignal = request.signal;
          return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true }));
        }) as typeof completeRedesignRequest,
        prove: async () => passingProof(),
      });
      const timeoutExpectation = expect(pending).rejects.toMatchObject({ code: "storefront_redesign_timeout" });
      await vi.advanceTimersByTimeAsync(600_000);
      await timeoutExpectation;
      expect(providerSignal?.aborted).toBe(true);

      const lateProof = vi.fn(async ({ signal }: { signal?: AbortSignal }) =>
        new Promise<BrowserProofReport>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })));
      const totalPending = runStorefrontRedesign(input("structural_edit"), {
        complete: (<T>(request: RedesignProviderRequest<T>) => new Promise<RedesignProviderResult<T>>((resolve) => setTimeout(() => resolve({
          value: request.parse({ routeId: "product", route: source.routes.product }), audit: providerAudit,
        }), 500_000))),
        prove: lateProof,
      });
      const totalExpectation = expect(totalPending).rejects.toMatchObject({ code: "storefront_redesign_timeout" });
      await vi.advanceTimersByTimeAsync(500_000);
      expect(lateProof).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100_000);
      await totalExpectation;

      const prove = vi.fn(async ({ timeoutMs, signal }: { timeoutMs?: number; signal?: AbortSignal }) => {
        expect(timeoutMs).toBe(180_000);
        return new Promise<BrowserProofReport>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      });
      const proofPending = runStorefrontRedesign(input("structural_edit"), {
        complete: fakeComplete(() => ({ routeId: "product", route: source.routes.product })), prove,
      });
      const proofExpectation = expect(proofPending).rejects.toMatchObject({ code: "storefront_redesign_proof_timeout" });
      await vi.advanceTimersByTimeAsync(180_000);
      await proofExpectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
