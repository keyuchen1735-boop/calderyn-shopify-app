import { describe, expect, it } from "vitest";
import { validationLimitsV1, validateCompiledBundle } from "./validate";
import type { StorefrontBundleV1 } from "../storefront-bundle/types";
import { compileBundle } from "./compile";
import { VALID_BUNDLE_SOURCE } from "./__fixtures__/valid-bundle";

describe("validation profile v1", () => {
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
});
