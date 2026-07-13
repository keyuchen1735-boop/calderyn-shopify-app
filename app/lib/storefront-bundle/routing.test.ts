import { describe, expect, it } from "vitest";
import { EMPTY_EVIDENCE_INPUT, INVALID_REQUESTS, REQUIRED_ROUTING_CORPUS } from "./__fixtures__/routing-corpus";
import { STORE_TEMPLATE_REGISTRY } from "./registry";
import { parseStoreDesignRequest, resolveStoreDesign } from "./routing";
import type { CatalogRoutingEvidence, StoreDesignRequest } from "./types";

const evidence = (overrides: Partial<Omit<CatalogRoutingEvidence, "fingerprint">> = {}): CatalogRoutingEvidence => ({
  ...EMPTY_EVIDENCE_INPUT,
  ...overrides,
  fingerprint: "sha256:fixture",
});

describe("store design request validation", () => {
  for (const fixture of INVALID_REQUESTS) {
    it(`rejects ${fixture.name}`, () => {
      expect(parseStoreDesignRequest(fixture.value, STORE_TEMPLATE_REGISTRY)).toEqual({
        ok: false,
        error: "invalid_design_request",
      });
    });
  }

  it("trims and preserves a valid Unicode prompt by code point", () => {
    expect(parseStoreDesignRequest({ prompt: "  Crème d’Or — 店  ", mode: "auto" }, STORE_TEMPLATE_REGISTRY)).toEqual({
      ok: true,
      value: { prompt: "Crème d’Or — 店", mode: "auto" },
    });
    expect(parseStoreDesignRequest({ prompt: "😀".repeat(4_000), mode: "auto" }, STORE_TEMPLATE_REGISTRY).ok).toBe(true);
  });
});

describe("deterministic store design resolver", () => {
  for (const fixture of REQUIRED_ROUTING_CORPUS) {
    it(fixture.name, () => {
      const resolution = resolveStoreDesign(
        { prompt: fixture.prompt, mode: "auto" },
        evidence(fixture.evidence),
        STORE_TEMPLATE_REGISTRY,
      );
      expect(resolution.kind).toBe(fixture.expectedKind);
      if (resolution.kind === "recipe") expect(resolution.templateId).toBe(fixture.templateId);
      else expect(resolution.reason).toBe(fixture.reason);
    });
  }

  it("honors manual recipe and custom precedence without fabricated matcher metrics", () => {
    const manual = resolveStoreDesign(
      { prompt: "build from scratch", mode: "recipe", templateId: "atelier-nine" },
      evidence(),
      STORE_TEMPLATE_REGISTRY,
    );
    expect(manual).toMatchObject({
      kind: "recipe",
      templateId: "atelier-nine",
      templateVersion: 1,
      selectionKind: "manual_override",
      score: null,
      runnerUpScore: null,
      margin: null,
      confidenceBand: null,
      breakdown: [],
    });
    expect(resolveStoreDesign({ prompt: "pet health", mode: "custom" }, evidence(), STORE_TEMPLATE_REGISTRY)).toMatchObject({
      kind: "custom",
      reason: "manual_override",
      breakdown: [],
    });
  });

  it("normalizes Unicode, canonical apostrophes, and hyphens without substring matches", () => {
    const unicode = resolveStoreDesign(
      { prompt: "DON’T use Atelier — use Soft‑Chemistry", mode: "auto" },
      evidence(),
      STORE_TEMPLATE_REGISTRY,
    );
    expect(unicode).toMatchObject({ kind: "recipe", templateId: "soft-chemistry" });
    const substring = resolveStoreDesign({ prompt: "My therapist sells restore kits", mode: "auto" }, evidence(), STORE_TEMPLATE_REGISTRY);
    expect(substring.kind).toBe("custom");
  });

  it("scores longest non-overlapping phrases once and excludes their prompt terms", () => {
    const result = resolveStoreDesign(
      { prompt: "clean skin care clean skin care sensitive skin", mode: "auto" },
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
    expect(resolveStoreDesign({ prompt: "Make me a store", mode: "auto" }, catalogOnly, STORE_TEMPLATE_REGISTRY)).toMatchObject({
      kind: "custom",
      reason: "low_confidence",
    });
    const tie = resolveStoreDesign(
      { prompt: "clean skincare pet health", mode: "auto" },
      evidence(),
      STORE_TEMPLATE_REGISTRY,
    );
    expect(tie).toMatchObject({ kind: "custom", reason: "low_confidence" });
  });

  it("requires empty-prompt catalog evidence from two independent fields", () => {
    const oneField = evidence({ productTags: ["pet supplement", "dog health", "cat wellness", "pet care"] });
    expect(resolveStoreDesign({ prompt: "", mode: "auto" }, oneField, STORE_TEMPLATE_REGISTRY)).toMatchObject({
      kind: "custom",
      reason: "low_confidence",
    });
    const twoFields = evidence({ productTypes: ["pet supplement", "dog health"], collectionTitles: ["pet wellness", "pet care"] });
    expect(resolveStoreDesign({ prompt: "", mode: "auto" }, twoFields, STORE_TEMPLATE_REGISTRY)).toMatchObject({
      kind: "recipe",
      templateId: "companion-field-guide",
    });
  });

  it("returns stable score ordering, thresholds, reasons, and metadata", () => {
    const request: StoreDesignRequest = { prompt: "specialty pet health supplements", mode: "auto" };
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
