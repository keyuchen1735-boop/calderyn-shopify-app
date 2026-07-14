import { describe, expect, it } from "vitest";
import { validationLimitsV1, validateCompiledBundle } from "./validate";
import type { CompiledElementNode, CompiledNode, StorefrontBundleV1 } from "../storefront-bundle/types";
import { compileBundle } from "./compile";
import { VALID_BUNDLE_SOURCE } from "./__fixtures__/valid-bundle";
import { compileCss } from "./css";
import { serializeCompiledTree } from "./html";

function compileRouteTargetScopeFixture() {
  const source = structuredClone(VALID_BUNDLE_SOURCE);
  source.routes.collection.html = `
    <main>
      <a id="root-anchor" data-cd-route="collection" data-cd-param-handle="collection.handle">Collection</a>
      <section data-cd-repeat="collection.products">
        <a id="first-anchor" data-cd-route="product" data-cd-param-handle="product.handle">First</a>
      </section>
      <section data-cd-repeat="collection.products">
        <a id="second-anchor" data-cd-route="product" data-cd-param-handle="product.handle">Second</a>
      </section>
    </main>`;
  return compileBundle(source).bundle;
}

function flattenElements(nodes: readonly CompiledNode[]): CompiledElementNode[] {
  const elements: CompiledElementNode[] = [];
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    elements.push(node, ...flattenElements(node.children));
  }
  return elements;
}

describe("validation profile v1", () => {
  it("accepts compiled bounded search inputs and static machine values", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.search.html = `<main><input type="search" name="q" placeholder="Search products" value="initial" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Search</button></main>`;

    expect(compileBundle(source).report).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("rejects forged persisted control attributes", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.search.html = `<main><input type="search" name="q"></main>`;
    const bundle = compileBundle(source).bundle;
    const input = flattenElements(bundle.routes.search.tree).find((node) => node.tag === "input");
    if (!input) throw new Error("input fixture is missing");
    input.attributes.type = "password";
    input.attributes.value = "x".repeat(121);

    expect(validateCompiledBundle(bundle).diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["tree.control_attribute"]),
    );
  });

  it("rejects persisted cart-line controls whose exact repeat scope was removed", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.cart.html = `<main data-cd-repeat="cart.lines"><div data-cd-key="cartLine.id" data-cd-slot="cartLineControls"></div></main>`;
    const bundle = compileBundle(source).bundle;
    const slot = bundle.routes.cart.trustedSlots[0];
    if (!slot) throw new Error("fixture cart-line slot is missing");
    expect(slot.scopeId).toBe("cd-cart-scope-1");
    slot.scopeId = undefined;
    expect(validateCompiledBundle(bundle).diagnostics.map((item) => item.code)).toContain("slot.scope");
  });

  it("rejects unknown and malformed deserialized input without throwing", () => {
    expect(validateCompiledBundle(null).ok).toBe(false);
    expect(validateCompiledBundle({}).ok).toBe(false);

    const valid = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
    const malformed = structuredClone(valid) as unknown as Record<string, unknown>;
    const routes = (malformed.routes as Record<string, Record<string, unknown>>);
    const home = routes.home!;
    home.tree = [{ kind: "element", id: "bad", tag: "script", attributes: { onclick: "evil" }, children: [] }];
    home.bindings = [{ id: "b", targetId: "bad", kind: "text", ref: { kind: "data", scopeId: "root", path: "product.shop_id" } }];
    home.css = `body { display: none }`;
    home.interactions = { version: 1, state: [], bindings: [], transitions: [{ on: "click", sourceId: "bad", action: { type: "cart.add" } }] };
    home.trustedSlots = [{ id: "bad", kind: "fake", hostSize: "page", themeTokenIds: [] }];
    const report = validateCompiledBundle(malformed);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "tree.tag",
        "tree.attribute",
        "binding.path",
        "route.css_scope",
        "interaction.action",
        "slot.kind",
      ]),
    );
  });
  it("publishes the exact compiler byte/count limits", () => {
    expect(validationLimitsV1.routeHtmlCssBytes).toBe(250 * 1024);
    expect(validationLimitsV1.interactionManifestBytes).toBe(40 * 1024);
    expect(validationLimitsV1.bundleExcludingImagesBytes).toBe(1_500 * 1024);
    expect(validationLimitsV1.maxStatesPerRoute).toBeGreaterThan(0);
    expect(validationLimitsV1.maxActionsPerRoute).toBeGreaterThan(0);
  });

  it("returns deterministic diagnostics for oversized and unresolved artifacts", () => {
    const bundle = {
      schemaVersion: 1,
      runtimeVersion: 1,
      validationProfileVersion: 1,
      shell: { html: "x".repeat(250 * 1024), css: "x", interactions: { version: 1, state: [], bindings: [], transitions: [] }, trustedSlots: [], requiredData: [], requiredCapabilities: [] },
      routes: {},
      assets: { entries: [] },
    } as unknown as StorefrontBundleV1;
    const report = validateCompiledBundle(bundle);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((item) => item.code)).toContain("route.byte_limit");
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    expect(report.diagnostics).toEqual([...report.diagnostics].sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code)));
  });

  it("enforces state and action counts and unresolved targets", () => {
    const shell = {
      html: "",
      tree: [],
      bindings: [],
      css: "",
      interactions: {
        version: 1 as const,
        state: Array.from({ length: validationLimitsV1.maxStatesPerRoute + 1 }, (_, index) => ({
          id: `state-${index}`,
          type: "boolean" as const,
          initial: false,
        })),
        bindings: [],
        transitions: Array.from({ length: validationLimitsV1.maxActionsPerRoute + 1 }, () => ({
          on: "click" as const,
          sourceId: "missing",
          action: { type: "search.clear" as const },
        })),
      },
      trustedSlots: [],
      requiredData: [],
      requiredCapabilities: [],
    };
    const report = validateCompiledBundle({
      schemaVersion: 1,
      runtimeVersion: 1,
      validationProfileVersion: 1,
      shell,
      routes: {},
      assets: { entries: [] },
    } as unknown as StorefrontBundleV1);
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["interaction.state_limit", "interaction.action_limit", "interaction.unresolved_source"]),
    );
  });

  it("rejects persisted global CSS that reaches a protected node in any route", () => {
    const bundle = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
    bundle.designSystem.globalCss = compileCss(`.product { display: none }`, { namespace: "global" }).css;
    const report = validateCompiledBundle(bundle);
    expect(report.diagnostics.map((item) => item.code)).toContain("bundle.global_css");
  });

  it("rejects forged repeat parents and cross-scope public data refs", () => {
    const illegalRepeat = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
    const homeRoot = illegalRepeat.routes.home.tree[0];
    if (!homeRoot || homeRoot.kind !== "element") throw new Error("fixture home root is missing");
    homeRoot.repeat = { scopeId: "cd-home-forged", source: "cart.lines", itemKind: "cartLine", keyPath: "cartLine.id" };
    homeRoot.attributes["data-cd-repeat-id"] = homeRoot.repeat.scopeId;
    illegalRepeat.routes.home.html = serializeCompiledTree(illegalRepeat.routes.home.tree);
    expect(validateCompiledBundle(illegalRepeat).diagnostics.map((item) => item.code)).toContain("tree.repeat_scope");

    const crossScope = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
    const binding = crossScope.routes.collection.bindings[0];
    if (!binding) throw new Error("fixture collection binding is missing");
    binding.ref = { kind: "data", scopeId: binding.ref.kind === "data" ? binding.ref.scopeId : "missing", path: "cartLine.title" };
    expect(validateCompiledBundle(crossScope).diagnostics.map((item) => item.code)).toContain("binding.scope");
  });

  it("applies compiler-equivalent token and asset validation to persisted bundles", () => {
    const bundle = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
    bundle.designSystem.tokens.ink = String.raw`u\72l("https://evil.example/token")`;
    bundle.assets.entries = [{ key: "hero", contentHash: "a".repeat(16), mediaType: "text/html", byteSize: 1 }];
    const codes = validateCompiledBundle(bundle).diagnostics.map((item) => item.code);
    expect(codes).toContain("bundle.tokens");
    expect(codes).toContain("asset.entry");
  });

  it("accepts compiler-generated route targets bound to their owning element scope", () => {
    expect(validateCompiledBundle(compileRouteTargetScopeFixture()).ok).toBe(true);
  });

  it("rejects a forged route target that borrows a sibling repeat scope", () => {
    const bundle = compileRouteTargetScopeFixture();
    const collection = bundle.routes.collection;
    const elements = flattenElements(collection.tree);
    const firstScope = elements.find((node) => node.repeat)?.repeat?.scopeId;
    const secondAnchor = elements.find((node) => node.id === "cd-collection-second-anchor");
    if (!firstScope || !secondAnchor?.routeTarget) throw new Error("route-target fixture is malformed");
    secondAnchor.routeTarget.params.handle = { kind: "data", scopeId: firstScope, path: "product.handle" };
    expect(validateCompiledBundle(bundle).diagnostics.map((item) => item.code)).toContain("route.scope");
  });

  it("rejects a root anchor that borrows a nested repeat scope", () => {
    const bundle = compileRouteTargetScopeFixture();
    const collection = bundle.routes.collection;
    const elements = flattenElements(collection.tree);
    const nestedScope = elements.find((node) => node.repeat)?.repeat?.scopeId;
    const rootAnchor = elements.find((node) => node.id === "cd-collection-root-anchor");
    if (!nestedScope || !rootAnchor) throw new Error("route-target fixture is malformed");
    rootAnchor.routeTarget = {
      routeId: "product",
      params: { handle: { kind: "data", scopeId: nestedScope, path: "product.handle" } },
    };
    expect(validateCompiledBundle(bundle).diagnostics.map((item) => item.code)).toContain("route.scope");
  });
});
