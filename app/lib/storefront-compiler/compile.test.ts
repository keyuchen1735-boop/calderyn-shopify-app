import { describe, expect, it } from "vitest";
import { compileBundle, hashCompiledBundle, type StorefrontBundleSourceV1 } from "./compile";

describe("compileBundle", () => {
  it("compiles and hashes the same source deterministically", async () => {
    const source: StorefrontBundleSourceV1 = {
      source: { kind: "custom" as const, generationId: "gen-1", promptHash: "prompt" },
      concept: { name: "Example", rationale: "Clear", noveltySignature: ["grid"] },
      designSystem: {
        displayFontId: "fraunces" as const,
        bodyFontId: "inter" as const,
        tokens: { ink: "#111111" },
        breakpoints: { mobile: 390 },
        iconStyle: "line",
        motionStyle: "restrained",
        globalCss: `.shell { color: var(--ink) }`,
      },
      shell: { html: `<header data-cd-text="store.name"></header>`, css: `.shell { display:grid }`, requiredData: [{ kind: "storeIdentity" as const }], requiredCapabilities: [] },
      routes: {
        home: { html: `<main><h1 data-cd-text="store.name"></h1></main>`, css: `main { display:block }`, requiredData: [{ kind: "storeIdentity" as const }], requiredCapabilities: [] },
        collection: { html: `<main data-cd-repeat="collection.products"><article data-cd-key="product.id" data-cd-text="product.title"></article></main>`, css: `main { display:grid }`, requiredData: [{ kind: "currentCollection" as const }], requiredCapabilities: [] },
        product: { html: `<main><h1 data-cd-text="product.title"></h1><div id="buy" data-cd-slot="addToCart" data-cd-host-size="block"></div></main>`, css: `main { display:grid }`, requiredData: [{ kind: "currentProduct" as const }], requiredCapabilities: ["commerce" as const], rootScopeKind: "product" as const },
        search: { html: `<main><h1>Search</h1></main>`, css: `main { display:block }`, requiredData: [{ kind: "searchResults" as const, limit: 12 }], requiredCapabilities: ["catalogSearch" as const] },
        cart: { html: `<main><div id="summary" data-cd-slot="cartSummary" data-cd-host-size="page"></div></main>`, css: `main { display:block }`, requiredData: [{ kind: "cart" as const }], requiredCapabilities: ["commerce" as const] },
        checkout: { html: `<header data-cd-text="store.name"></header>`, css: `header { display:block }`, layout: { columnMode: "summaryAside" as const, sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"], spacingTokenId: "space-4", surfaceTokenIds: ["surface"] } },
      },
      assets: { entries: [] },
    };
    const first = await compileBundle(source);
    const second = await compileBundle(source);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toBe(await hashCompiledBundle(first.bundle));
    expect(first.report.ok).toBe(true);

    const changedTree = structuredClone(first.bundle);
    changedTree.routes.home.tree.push({ kind: "text", value: "changed" });
    expect(hashCompiledBundle(changedTree)).not.toBe(first.hash);
    const changedBinding = structuredClone(first.bundle);
    changedBinding.routes.home.bindings[0]!.ref = { kind: "literal", value: "changed" };
    expect(hashCompiledBundle(changedBinding)).not.toBe(first.hash);

    const missingDataPlan = structuredClone(source);
    missingDataPlan.shell.requiredData = [];
    expect(compileBundle(missingDataPlan).report.diagnostics.map((item) => item.code)).toContain(
      "data.missing_requirement",
    );
  });
});
