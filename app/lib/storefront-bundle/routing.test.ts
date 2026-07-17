import { describe, expect, it } from "vitest";
import { EMPTY_EVIDENCE_INPUT, REQUIRED_ROUTING_CORPUS } from "./__fixtures__/routing-corpus";
import { STORE_TEMPLATE_REGISTRY } from "./registry";
import { resolveStoreDesign } from "./routing";
import type { CatalogRoutingEvidence, StoreDesignRequest } from "./types";

const evidence = (overrides: Partial<Omit<CatalogRoutingEvidence, "fingerprint">> = {}): CatalogRoutingEvidence => ({
  ...EMPTY_EVIDENCE_INPUT,
  ...overrides,
  fingerprint: "sha256:fixture",
});

describe("deterministic store design resolver", () => {
  for (const fixture of REQUIRED_ROUTING_CORPUS) {
    it(fixture.name, () => {
      const resolution = resolveStoreDesign(
        { prompt: fixture.prompt },
        evidence(fixture.evidence),
        STORE_TEMPLATE_REGISTRY,
      );
      expect(resolution.kind).toBe(fixture.expectedKind);
      if (resolution.kind === "recipe") expect(resolution.templateId).toBe(fixture.templateId);
    });
  }

  it("reaches every registered design through the prompt corpus", () => {
    const reached = new Set(REQUIRED_ROUTING_CORPUS.flatMap((fixture) => {
      const resolution = resolveStoreDesign(
        { prompt: fixture.prompt },
        evidence(fixture.evidence),
        STORE_TEMPLATE_REGISTRY,
      );
      return resolution.kind === "recipe" ? [resolution.templateId] : [];
    }));

    expect(reached).toEqual(new Set(STORE_TEMPLATE_REGISTRY.templates.map(({ id }) => id)));
  });

  it("normalizes Unicode, canonical apostrophes, and hyphens without substring matches", () => {
    const unicode = resolveStoreDesign(
      { prompt: "DON’T use Atelier — use Soft‑Chemistry" },
      evidence(),
      STORE_TEMPLATE_REGISTRY,
    );
    expect(unicode).toMatchObject({ kind: "recipe", templateId: "soft-chemistry" });
    const substring = resolveStoreDesign({ prompt: "My therapist sells restore kits" }, evidence(), STORE_TEMPLATE_REGISTRY);
    expect(substring).toMatchObject({ kind: "recipe", templateId: "custom-bench" });
  });

  it("does not treat narrative originality or compounded no-template gaps as explicit custom intent", () => {
    expect(
      resolveStoreDesign(
        { prompt: "We make something completely new for every product launch" },
        evidence(),
        STORE_TEMPLATE_REGISTRY,
      ),
    ).toMatchObject({ kind: "recipe", templateId: "custom-bench" });
    expect(
      resolveStoreDesign(
        { prompt: "Avoid ever choosing to use any kind of template for my clean skincare store" },
        evidence(),
        STORE_TEMPLATE_REGISTRY,
      ),
    ).toMatchObject({ kind: "recipe", templateId: "soft-chemistry" });
  });

  it("keeps governed recipe-name negation local to that occurrence", () => {
    expect(
      resolveStoreDesign(
        { prompt: "Do not pick Atelier; use Soft Chemistry" },
        evidence(),
        STORE_TEMPLATE_REGISTRY,
      ),
    ).toMatchObject({ kind: "recipe", templateId: "soft-chemistry", selectionKind: "explicit_name" });
    expect(
      resolveStoreDesign(
        { prompt: "Do not choose Soft Chemistry; use Atelier" },
        evidence(),
        STORE_TEMPLATE_REGISTRY,
      ),
    ).toMatchObject({ kind: "recipe", templateId: "atelier-nine", selectionKind: "explicit_name" });
    expect(
      resolveStoreDesign(
        { prompt: "Do not feature Atelier; use Soft Chemistry" },
        evidence(),
        STORE_TEMPLATE_REGISTRY,
      ),
    ).toMatchObject({ kind: "recipe", templateId: "soft-chemistry", selectionKind: "explicit_name" });
    expect(
      resolveStoreDesign(
        { prompt: "Do not recommend Atelier; use Soft Chemistry" },
        evidence(),
        STORE_TEMPLATE_REGISTRY,
      ),
    ).toMatchObject({ kind: "recipe", templateId: "soft-chemistry", selectionKind: "explicit_name" });
  });

  it("does not let distant or prior-clause negation govern a positive recipe name", () => {
    expect(
      resolveStoreDesign(
        { prompt: "Do not revise the catalog notes. Feature Atelier" },
        evidence(),
        STORE_TEMPLATE_REGISTRY,
      ),
    ).toMatchObject({ kind: "recipe", templateId: "atelier-nine", selectionKind: "explicit_name" });
    expect(
      resolveStoreDesign(
        { prompt: "I do not like the launch notes that recommend Atelier" },
        evidence(),
        STORE_TEMPLATE_REGISTRY,
      ),
    ).toMatchObject({ kind: "recipe", templateId: "atelier-nine", selectionKind: "explicit_name" });
  });

  it("keeps focus constructions positive while choosing one first-build recipe", () => {
    for (const prompt of [
      "Not only Atelier but Soft Chemistry",
      "Not just Atelier or Soft Chemistry",
      "Not merely Atelier; also Soft Chemistry",
      "Not exclusively Atelier, maybe Soft Chemistry",
      "Not simply Atelier but Soft Chemistry",
    ]) {
      expect(resolveStoreDesign({ prompt }, evidence(), STORE_TEMPLATE_REGISTRY).kind).toBe("recipe");
    }
  });

  it("chooses one recipe when a first auto prompt names multiple recipes", () => {
    expect(resolveStoreDesign(
      { prompt: "Try Atelier Grid or Soft Chemistry" },
      evidence(),
      STORE_TEMPLATE_REGISTRY,
    ).kind).toBe("recipe");
  });

  it("scores longest non-overlapping phrases once and excludes their prompt terms", () => {
    const result = resolveStoreDesign(
      { prompt: "clean skin care clean skin care sensitive skin" },
      evidence(),
      STORE_TEMPLATE_REGISTRY,
    );
    expect(result).toMatchObject({ kind: "recipe", templateId: "soft-chemistry" });
    const soft = result.breakdown.find((entry) => entry.templateId === "soft-chemistry");
    expect(soft?.strongPhraseHits).toEqual(expect.arrayContaining(["clean skin care", "sensitive skin"]));
    expect(soft?.strongPhraseHits.filter((term) => term === "clean skin care")).toHaveLength(1);
    expect(soft?.promptTermHits).not.toContain("skin");
  });

  it("requires score, margin, and a prompt-side signal for non-empty prompts", () => {
    const catalogOnly = evidence({
      productTypes: ["pet supplement"],
      productTags: ["dog health"],
      collectionTitles: ["pet wellness"],
    });
    expect(resolveStoreDesign({ prompt: "Make me a store" }, catalogOnly, STORE_TEMPLATE_REGISTRY)).toMatchObject({
      kind: "recipe",
      templateId: "companion-field-guide",
    });
    const tie = resolveStoreDesign(
      { prompt: "clean skincare pet health" },
      evidence(),
      STORE_TEMPLATE_REGISTRY,
    );
    expect(tie).toMatchObject({ kind: "recipe", templateId: "soft-chemistry" });
  });

  it("always gives a first auto prompt a complete recipe instead of the slow custom compiler", () => {
    expect(resolveStoreDesign({ prompt: "Make me a store" }, evidence(), STORE_TEMPLATE_REGISTRY)).toMatchObject({
      kind: "recipe",
      templateId: "custom-bench",
    });
  });

  it("filters exclusions before name and score matching", () => {
    const result = resolveStoreDesign({
      prompt: "Use Soft Chemistry",
      excludedTemplateIds: ["soft-chemistry"],
    }, evidence({ productTypes: ["skincare"] }), STORE_TEMPLATE_REGISTRY);

    expect(result).toMatchObject({ kind: "recipe" });
    if (result.kind === "recipe") expect(result.templateId).not.toBe("soft-chemistry");
    expect(result.breakdown.some(({ templateId }) => templateId === "soft-chemistry")).toBe(false);
  });

  it("returns no match when every approved design is excluded", () => {
    expect(resolveStoreDesign({
      prompt: "Try another",
      excludedTemplateIds: STORE_TEMPLATE_REGISTRY.templates.map(({ id }) => id),
    }, evidence(), STORE_TEMPLATE_REGISTRY)).toMatchObject({
      kind: "no_match",
      reason: "all_designs_excluded",
      breakdown: [],
    });
  });

  it("routes from-scratch language to an approved design", () => {
    expect(resolveStoreDesign({
      prompt: "Create a completely new store from scratch",
    }, evidence(), STORE_TEMPLATE_REGISTRY)).toMatchObject({ kind: "recipe" });
  });

  it("requires empty-prompt catalog evidence from two independent fields", () => {
    const oneField = evidence({ productTags: ["pet supplement", "dog health", "cat wellness", "pet care"] });
    expect(resolveStoreDesign({ prompt: "" }, oneField, STORE_TEMPLATE_REGISTRY)).toMatchObject({
      kind: "recipe",
      templateId: "companion-field-guide",
    });
    const twoFields = evidence({ productTypes: ["pet supplement", "dog health"], collectionTitles: ["pet wellness", "pet care"] });
    expect(resolveStoreDesign({ prompt: "" }, twoFields, STORE_TEMPLATE_REGISTRY)).toMatchObject({
      kind: "recipe",
      templateId: "companion-field-guide",
    });
  });

  it("returns stable score ordering, thresholds, reasons, and metadata", () => {
    const request: StoreDesignRequest = { prompt: "specialty pet health supplements" };
    const first = resolveStoreDesign(request, evidence({ productTypes: ["pet supplement"] }), STORE_TEMPLATE_REGISTRY);
    const second = resolveStoreDesign(request, evidence({ productTypes: ["pet supplement"] }), STORE_TEMPLATE_REGISTRY);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      kind: "recipe",
      templateId: "companion-field-guide",
      routingVersion: 1,
      registryVersion: 1,
      catalogFingerprint: "sha256:fixture",
    });
    if (first.kind === "recipe") {
      expect(first.score).toBeGreaterThanOrEqual(6);
      expect(first.margin).toBeGreaterThanOrEqual(2);
      expect(first.reasons.length).toBeGreaterThan(0);
    }
  });

});
