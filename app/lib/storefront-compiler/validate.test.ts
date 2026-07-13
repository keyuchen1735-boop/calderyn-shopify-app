import { describe, expect, it } from "vitest";
import { validationLimitsV1, validateCompiledBundle } from "./validate";
import type { StorefrontBundleV1 } from "../storefront-bundle/types";

describe("validation profile v1", () => {
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
    expect(report.diagnostics).toEqual([...report.diagnostics].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)));
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
