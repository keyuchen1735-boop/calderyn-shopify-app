import { describe, expect, it, vi } from "vitest";
import { createConcept, createContext, PASSING_JUDGE_SCORES } from "./__fixtures__/deterministic";
import { exploreConcepts } from "./concepts.server";
import { calculateNovelty, rankConcepts } from "./judge.server";
import type { StorefrontAiProvider } from "./contracts";

describe("concept exploration", () => {
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
      compileConcept: (candidate) => ({ candidate, compiledFingerprint: candidate.candidateId }),
    });

    expect(maxActive).toBe(3);
    expect(result.candidates).toHaveLength(3);
    expect(result.repairs).toBe(1);
    expect(complete.mock.calls.filter(([request]) => request.operation === "concept")).toHaveLength(3);
    expect(complete.mock.calls.filter(([request]) => request.operation === "repairConcept")).toHaveLength(1);
    expect(new Set(result.candidates.map((item) => item.strategy))).toEqual(new Set(["asymmetric-commerce", "narrative-utility", "spatial-catalog"]));
    expect(new Set(result.candidates.map((item) => item.candidate.concept.noveltySignature.layoutTopology)).size).toBe(3);
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
        return { candidate, compiledFingerprint: candidate.candidateId };
      },
    });
    expect(result.candidates).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.repairs).toBe(1);
  });
});

describe("novelty and visual judging", () => {
  it("requires distance on at least three axes and a score of 75", () => {
    const context = createContext();
    const close = { ...context.recipeNoveltySignatures[0].signature, layoutTopology: "different" };
    expect(calculateNovelty(close, context.recipeNoveltySignatures)).toMatchObject({ passed: false, score: 20 });
    expect(calculateNovelty(createConcept(0).concept.noveltySignature, context.recipeNoveltySignatures)).toMatchObject({ passed: true, score: 100 });
  });

  it("renders actual merchant data and ranks only candidates above every quality floor", async () => {
    const context = createContext();
    const candidates = [0, 1, 2].map((index) => ({ candidate: createConcept(index), compiledFingerprint: `f${index}`, strategy: "asymmetric-commerce" as const }));
    const render = vi.fn(async ({ context: received }) => ({ desktop: `desktop:${received.products[0].title}`, mobile: "mobile" }));
    const provider: StorefrontAiProvider = {
      complete: vi.fn(async (request) => ({
        value: { scores: request.prompt.includes("Concept 2") ? { ...PASSING_JUDGE_SCORES, promptFit: 60 } : PASSING_JUDGE_SCORES, rationale: "fixture" },
        usage: { inputTokens: 1, outputTokens: 1 }, provider: "fixture", model: "fixture",
      })),
    };
    const ranked = await rankConcepts({ candidates, context, provider, render });
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[0][0].context.products[0].title).toBe("Arc Lamp");
    expect(ranked.accepted).toHaveLength(2);
    expect(ranked.rejected.some((item) => item.candidate.candidate.concept.name === "Concept 2")).toBe(true);
  });
});
