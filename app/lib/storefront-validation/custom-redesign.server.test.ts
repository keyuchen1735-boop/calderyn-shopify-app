import { describe, expect, it } from "vitest";
import { authoringFromRecipe, compileAuthoring } from "../storefront-ai/authoring.server";
import type { RunStorefrontRedesignInput, StorefrontRedesignResult } from "../storefront-ai/redesign.server";
import { createStoreCommandHarness } from "./command-harness.server";
import { storefrontProofContext } from "./fixtures";

const SHOP_ID = "11111111-1111-4111-8111-111111111111";
const ROUTES = ["home", "collection", "product", "search", "cart", "checkout"] as const;

function deterministicRedesign() {
  let calls = 0;
  return async (input: RunStorefrontRedesignInput): Promise<StorefrontRedesignResult> => {
    calls += 1;
    const generationId = `deterministic-${calls}`;
    const authoring = input.baseArtifact.authoring
      ? structuredClone(input.baseArtifact.authoring)
      : authoringFromRecipe(input.recipe!, {
          generationId,
          promptHash: input.context.context.promptHash,
          derivedFromVersionId: input.baseVersionId,
        }).authoring;
    authoring.source.source = {
      ...authoring.source.source,
      kind: "custom",
      generationId,
      promptHash: input.context.context.promptHash,
      derivedFromVersionId: input.baseVersionId,
    };
    const changedRouteIds = input.mode === "structural_edit" ? [input.scope!.routeId] : [...ROUTES];
    for (const routeId of changedRouteIds) {
      authoring.source.routes[routeId].css += `\n.lifecycle-${calls}-${routeId}{padding:0}`;
    }
    const compiled = compileAuthoring(authoring);
    if (!compiled.report.ok) throw new Error("deterministic redesign did not compile");
    return {
      artifact: { sourceKind: "custom", bundle: compiled.bundle, authoring },
      validation: compiled.report,
      browserProof: { ok: true, diagnostics: [], screenshots: [], browserMs: 0 },
      audit: {
        mode: input.mode,
        baseVersionId: input.baseVersionId,
        generationId,
        promptHash: input.context.context.promptHash,
        changedRouteIds,
        shellChanged: false,
        repairs: 0,
        provider: [],
      },
    };
  };
}

function lifecycleHarness(options: {
  redesign?: ReturnType<typeof deterministicRedesign>;
  enabled?: boolean;
} = {}) {
  return createStoreCommandHarness({
    shopId: SHOP_ID,
    context: storefrontProofContext(),
    classify: async (input) => {
      if (input.prompt === "Change the headline") {
        return { kind: "update_text", slot: "heroTitle", value: "A lifecycle headline" };
      }
      if (input.prompt === "Move products above the story") {
        return { kind: "structural_edit", scope: { routeId: input.context!.routeId } };
      }
      if (input.prompt === "Redesign the entire site from scratch" || input.prompt === "Fail redesign") {
        return { kind: "full_redesign" };
      }
      return { kind: "select_design", prompt: input.prompt, excludedTemplateIds: [] };
    },
    redesign: options.redesign ?? deterministicRedesign(),
    ...(options.enabled === undefined ? {} : { customRedesignEnabled: options.enabled }),
  });
}

describe("custom redesign lifecycle", () => {
  it("moves recipe to structural custom, redesigns, undoes, and publishes", async () => {
    const harness = lifecycleHarness();

    const initial = await harness.prompt("Build my store");
    expect(initial.bundle.source.kind).toBe("recipe");
    expect(harness.redesignCalls()).toBe(0);

    const bounded = await harness.prompt("Change the headline");
    expect(bounded.bundle.source.kind).toBe("recipe");
    expect(harness.redesignCalls()).toBe(0);
    const boundedRoutes = structuredClone(bounded.bundle.routes);

    const structural = await harness.prompt("Move products above the story", [], { routeId: "home" });
    expect(structural.bundle.source).toMatchObject({ kind: "custom", derivedFromVersionId: bounded.versionId });
    expect(structural.bundle.routes.home).not.toEqual(boundedRoutes.home);
    for (const routeId of ROUTES.filter((routeId) => routeId !== "home")) {
      expect(structural.bundle.routes[routeId]).toEqual(boundedRoutes[routeId]);
    }
    expect(harness.redesignCalls()).toBe(1);
    const structuralArtifact = structuredClone({
      sourceKind: "custom" as const,
      bundle: structural.bundle,
      authoring: structural.authoring!,
    });

    const full = await harness.prompt("Redesign the entire site from scratch");
    expect(full.bundle.source.kind).toBe("custom");
    for (const routeId of ROUTES) {
      expect(full.authoring!.source.routes[routeId]).not.toEqual(structural.authoring!.source.routes[routeId]);
    }

    const restored = await harness.undo();
    if (restored.status !== "installed") throw new Error("custom lifecycle Undo did not install");
    expect(restored.versionId).not.toBe(structural.versionId);
    expect(harness.currentVersionId()).toBe(restored.versionId);
    expect(harness.state().draft?.artifact).toEqual(structuralArtifact);
    await harness.publish();
    expect(harness.publishedVersionId()).toBe(restored.versionId);
  });

  it.each([
    ["malformed provider output", "storefront_redesign_response_invalid"],
    ["compiler rejection", "storefront_redesign_compile_failed"],
    ["missing trusted slot", "storefront_redesign_compile_failed"],
    ["browser proof failure", "storefront_redesign_proof_failed"],
  ])("keeps the recipe draft on %s", async (_label, code) => {
    const redesign = async () => { throw Object.assign(new Error(code), { code }); };
    const harness = lifecycleHarness({ redesign: redesign as ReturnType<typeof deterministicRedesign> });
    await harness.prompt("Build my store");
    const before = harness.currentVersionId();

    await expect(harness.prompt("Fail redesign")).rejects.toThrow();
    expect(harness.currentVersionId()).toBe(before);
  });

  it("keeps the draft on abort, flag-off, stale version, and missing authoring", async () => {
    const aborted = lifecycleHarness();
    await aborted.prompt("Build my store");
    const abortedVersion = aborted.currentVersionId();
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.run({
      kind: "prompt", prompt: "Fail redesign", expectedDraftVersionId: abortedVersion,
    }, controller.signal)).rejects.toThrow();
    expect(aborted.currentVersionId()).toBe(abortedVersion);

    const disabled = lifecycleHarness({ enabled: false });
    await disabled.prompt("Build my store");
    const disabledVersion = disabled.currentVersionId();
    await expect(disabled.prompt("Fail redesign")).rejects.toThrow();
    expect(disabled.currentVersionId()).toBe(disabledVersion);
    expect(disabled.redesignCalls()).toBe(0);

    const stale = lifecycleHarness();
    await stale.prompt("Build my store");
    const staleVersion = stale.currentVersionId();
    await expect(stale.run({
      kind: "prompt", prompt: "Fail redesign",
      expectedDraftVersionId: "99999999-9999-4999-8999-999999999999",
    })).rejects.toThrow();
    expect(stale.currentVersionId()).toBe(staleVersion);

    const valid = deterministicRedesign();
    const missing = lifecycleHarness({
      redesign: (async (input) => {
        const result = await valid(input);
        return { ...result, artifact: { sourceKind: "custom", bundle: result.artifact.bundle } } as never;
      }) as ReturnType<typeof deterministicRedesign>,
    });
    await missing.prompt("Build my store");
    const missingVersion = missing.currentVersionId();
    await expect(missing.prompt("Fail redesign")).rejects.toThrow();
    expect(missing.currentVersionId()).toBe(missingVersion);
  });
});
