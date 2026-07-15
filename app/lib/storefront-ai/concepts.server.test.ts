import { describe, expect, it, vi } from "vitest";
import { createConcept, createContext, PASSING_JUDGE_SCORES } from "./__fixtures__/deterministic";
import { compileConceptCandidate, compileConceptJudgeDesignCss, exploreConcepts, parseConceptCandidate } from "./concepts.server";
import { calculateNovelty, rankConcepts } from "./judge.server";
import type { StorefrontAiProvider } from "./contracts";

describe("concept exploration", () => {
  it("normalizes numeric breakpoint strings without weakening asset bounds", () => {
    const concept = createConcept(0) as unknown as Record<string, unknown>;
    (concept.designSystem as Record<string, unknown>).breakpoints = { sm: "640px", lg: "1024" };
    concept.assetRequests = Array.from({ length: 8 }, (_, index) => ({
      key: `asset-${index}`,
      purpose: `Generated asset ${index}`,
      required: false,
    }));

    const parsed = parseConceptCandidate(concept);

    expect(parsed.designSystem.breakpoints).toEqual({ sm: 640, lg: 1024 });
    expect(parsed.assetRequests).toHaveLength(8);
    (concept.assetRequests as unknown[]).push({ key: "asset-8", purpose: "Ninth asset", required: false });
    expect(() => parseConceptCandidate(concept)).toThrow("assetRequests must be a bounded array");
  });

  it("removes inert HTML comments before compiler validation", () => {
    const concept = createConcept(0);
    concept.shell.html = `<!-- generated shell -->${concept.shell.html}`;
    concept.home.html = `${concept.home.html}<!-- generated home -->`;
    concept.home.rootScopeKind = "cart";

    const parsed = parseConceptCandidate(concept);

    expect(parsed.shell.html).not.toContain("<!--");
    expect(parsed.home.html).not.toContain("<!--");
    expect(parsed.home.rootScopeKind).toBeUndefined();
    expect(() => compileConceptCandidate(parsed)).not.toThrow();
  });

  it("rejects concept HTML that is empty after comment removal", () => {
    const concept = createConcept(0);
    concept.home.html = "<!-- generated home -->";

    expect(() => parseConceptCandidate(concept)).toThrow(/non-empty HTML/i);
  });

  it("keeps AI concept global CSS empty until all protected routes exist", () => {
    const concept = createConcept(0);
    concept.designSystem.globalCss = `.shared { color: red }`;

    expect(() => parseConceptCandidate(concept)).toThrow(/globalCss must be empty/i);
  });

  it("generates three structural briefs in parallel and repairs invalid output once", async () => {
    let active = 0;
    let maxActive = 0;
    let conceptCalls = 0;
    const complete = vi.fn(async (request: Parameters<StorefrontAiProvider["complete"]>[0]) => {
      if (request.operation === "concept") {
        const call = conceptCalls++;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return { value: call === 0 ? { invalid: true } : createConcept(call), usage: { inputTokens: 1, outputTokens: 1 }, provider: "fixture", model: "fixture" };
      }
      return { value: createConcept(0), usage: { inputTokens: 1, outputTokens: 1 }, provider: "fixture", model: "fixture" };
    });
    const result = await exploreConcepts({
      context: createContext(),
      provider: { complete },
      compileConcept: (candidate) => compileConceptCandidate(candidate),
    });

    expect(maxActive).toBe(3);
    expect(result.candidates).toHaveLength(3);
    expect(result.repairs).toBe(1);
    expect(complete.mock.calls.filter(([request]) => request.operation === "concept")).toHaveLength(3);
    expect(complete.mock.calls.filter(([request]) => request.operation === "repairConcept")).toHaveLength(1);
    expect(new Set(result.candidates.map((item) => item.strategy))).toEqual(new Set(["asymmetric-commerce", "narrative-utility", "spatial-catalog"]));
    expect(new Set(result.candidates.map((item) => item.candidate.concept.noveltySignature.layoutTopology)).size).toBe(3);
  });

  it("repairs provider failures that return no prior candidate", async () => {
    const complete = vi.fn(async (request: Parameters<StorefrontAiProvider["complete"]>[0]) => {
      if (request.operation === "concept") throw new Error("Structured storefront output reached the token limit");
      const candidateNumber = Number(request.prompt.match(/concept-(\d)/)?.[1] ?? 1);
      const requestsCompleteCandidate = request.prompt.includes("Return the complete candidate object") &&
        request.prompt.includes("never a partial patch");
      return {
        value: requestsCompleteCandidate ? createConcept(candidateNumber - 1) : { candidateId: `concept-${candidateNumber}` },
        usage: { inputTokens: 1, outputTokens: 1 }, provider: "fixture", model: "fixture",
      };
    });

    const result = await exploreConcepts({ context: createContext(), provider: { complete }, compileConcept: compileConceptCandidate });

    expect(result.candidates).toHaveLength(3);
    expect(result.repairs).toBe(3);
    expect(complete.mock.calls.filter(([request]) => request.operation === "repairConcept").every(([request]) =>
      request.prompt.includes("PRIOR_OUTPUT:null")
    )).toBe(true);
  });

  it("rejects peer concepts with the same compiled structure even when their novelty prose differs", async () => {
    let index = 0;
    const provider: StorefrontAiProvider = {
      complete: vi.fn(async (request) => {
        const candidate = createConcept(0);
        candidate.candidateId = `concept-${(index % 3) + 1}`;
        candidate.concept.noveltySignature = createConcept(index++ % 3).concept.noveltySignature;
        return { value: candidate, usage: { inputTokens: 1, outputTokens: 1 }, provider: "fixture", model: "fixture" };
      }),
    };
    const result = await exploreConcepts({ context: createContext(), provider, compileConcept: compileConceptCandidate });
    expect(result.candidates).toHaveLength(1);
    expect(result.rejected.filter((item) => /compiled structure/i.test(item.reason))).toHaveLength(2);
  });

  it("repairs one compiler rejection, then rejects a second invalid attempt", async () => {
    let conceptIndex = 0;
    const provider: StorefrontAiProvider = {
      complete: vi.fn(async (request) => ({
        value: createConcept(request.operation === "repairConcept" ? 0 : conceptIndex++),
        usage: { inputTokens: 1, outputTokens: 1 }, provider: "fixture", model: "fixture",
      })),
    };
    const result = await exploreConcepts({
      context: createContext(),
      provider,
      compileConcept: (candidate) => {
        if (candidate.candidateId === "concept-1") throw new Error("compiler rejected script");
        return compileConceptCandidate(candidate);
      },
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.repairs).toBe(1);
  });
});

describe("novelty and visual judging", () => {
  it("renders the compiled design tokens, curated fonts, and global CSS in judge screenshots", () => {
    const concept = createConcept(0);
    concept.designSystem.globalCss = `.judge-accent { color: var(--ink) }`;
    const css = compileConceptJudgeDesignCss(concept);

    expect(css).toContain("@font-face");
    expect(css).toContain("--font-display:");
    expect(css).toContain("judge-accent");
    expect(css).toContain("var(--ink)");
  });

  it("requires distance on at least three axes and a score of 75", () => {
    const context = createContext();
    const close = { ...context.recipeNoveltySignatures[0].signature, layoutTopology: "different" };
    expect(calculateNovelty(close, context.recipeNoveltySignatures)).toMatchObject({ passed: false, score: 20 });
    expect(calculateNovelty(compileConceptCandidate(createConcept(0)).structuralSignature, context.recipeNoveltySignatures)).toMatchObject({ passed: true });
  });

  it("derives novelty from compiler trees, CSS, and interactions instead of candidate prose", () => {
    const first = createConcept(0);
    const renamed = structuredClone(first);
    renamed.concept.noveltySignature = createConcept(2).concept.noveltySignature;
    const firstCompiled = compileConceptCandidate(first);
    const renamedCompiled = compileConceptCandidate(renamed);
    expect(firstCompiled.structuralSignature).toEqual(renamedCompiled.structuralSignature);

    const structural = structuredClone(first);
    structural.home.html = `<main><aside><p>Spatial index</p></aside><section><h1 data-cd-text="store.name"></h1></section></main>`;
    expect(compileConceptCandidate(structural).structuralSignature).not.toEqual(firstCompiled.structuralSignature);
  });

  it("renders actual merchant data and ranks only candidates above every quality floor", async () => {
    const context = createContext();
    const candidates = [0, 1, 2].map((index) => ({ ...compileConceptCandidate(createConcept(index)), strategy: "asymmetric-commerce" as const }));
    const render = vi.fn(async ({ context: received }) => ({
      desktop: { key: `judge-desktop-${received.products[0].title.length}`, mediaType: "image/webp" as const, bytes: new Uint8Array([1]) },
      mobile: { key: "judge-mobile", mediaType: "image/webp" as const, bytes: new Uint8Array([2]) },
      browserMs: 12,
    }));
    const provider: StorefrontAiProvider = {
      complete: vi.fn(async (request) => ({
        value: { scores: request.prompt.includes("Concept 2") ? { ...PASSING_JUDGE_SCORES, promptFit: 60 } : PASSING_JUDGE_SCORES, rationale: "fixture" },
        usage: { inputTokens: 1, outputTokens: 1 }, provider: "fixture", model: "fixture",
      })),
    };
    const ranked = await rankConcepts({ candidates, context, provider, render });
    expect(render).toHaveBeenCalledTimes(3);
    expect(render.mock.calls[0][0].context.products[0].title).toBe("Arc Lamp");
    expect(provider.complete).toHaveBeenCalledWith(expect.objectContaining({
      operation: "judge",
      images: [expect.objectContaining({ key: expect.stringContaining("judge-desktop") }), expect.objectContaining({ key: "judge-mobile" })],
    }));
    expect(ranked.accepted).toHaveLength(2);
    expect(ranked.rejected.some((item) => item.candidate.candidate.concept.name === "Concept 2")).toBe(true);
  });
});
